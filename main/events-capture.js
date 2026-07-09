// OS-level "activity" telemetry, captured alongside video. Built for an IT
// support engineer's actual workflow (RDP/remote tools, admin portals, the
// PSA) rather than a developer's (no git anywhere in here on purpose).
//
// Three sources:
//   - window   -- which app/window had focus, for how long, coarsely
//                 categorized (the primary source; carries dwell time)
//   - terminal -- PowerShell command history (PSReadLine diff) plus an
//                 opt-in transcript capture for command+output
//   - browser  -- Chrome/Edge history, classified as admin-portal / kb-docs / other
//
// Everything here lives in the main process (full FS/child_process access),
// the same reasoning as desktopCapturer already being main-process-only.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let sqlite3 = null;
try {
  // Native module -- requires `npx electron-rebuild` after `npm install`.
  // If it isn't built for this Electron ABI, browser-history capture simply
  // no-ops rather than crashing the app.
  sqlite3 = require('better-sqlite3');
} catch {
  sqlite3 = null;
}

// ─── Window/app-focus activity (primary source) ────────────────────────────

const WINDOW_POLL_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class TicketScribeWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
while ($true) {
  try {
    $hwnd = [TicketScribeWin32]::GetForegroundWindow()
    $sb = New-Object System.Text.StringBuilder 512
    [TicketScribeWin32]::GetWindowText($hwnd, $sb, $sb.Capacity) | Out-Null
    $procId = 0
    [TicketScribeWin32]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
    $procName = ""
    try { $procName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
    $title = $sb.ToString() -replace "\\|", "/"
    Write-Output ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString() + "|" + $procName + "|" + $title)
  } catch {}
  Start-Sleep -Milliseconds 1500
}
`;

const REMOTE_PROCESSES = ['mstsc', 'screenconnect', 'connectwisecontrol', 'connectwise', 'anydesk', 'teamviewer', 'rustdesk', 'splashtop'];
const TERMINAL_PROCESSES = ['powershell', 'pwsh', 'cmd', 'windowsterminal', 'conhost'];
const ADMIN_CONSOLE_TITLE_RE = /portal\.azure\.com|admin\.microsoft\.com|entra\.microsoft\.com|outlook\.office|exchange admin|intune|endpoint\.microsoft\.com/i;
const PSA_TITLE_RE = /halo(itsm|servicedesk|psa)?/i;

function classifyWindow(processName, windowTitle) {
  const proc = (processName || '').toLowerCase();
  const title = windowTitle || '';

  if (REMOTE_PROCESSES.some(p => proc.includes(p))) return 'remote';
  if (ADMIN_CONSOLE_TITLE_RE.test(title)) return 'admin-console';
  if (PSA_TITLE_RE.test(title)) return 'psa';
  if (TERMINAL_PROCESSES.some(p => proc.includes(p))) return 'terminal';
  return 'other';
}

let pollProcess = null;
let windowEntries = [];
let currentWindowEntry = null;

function handleWindowSample(timestamp, processName, windowTitle) {
  const isSameWindow = currentWindowEntry
    && currentWindowEntry.processName === processName
    && currentWindowEntry.windowTitle === windowTitle;

  if (isSameWindow) {
    currentWindowEntry.durationMs = timestamp - currentWindowEntry.timestamp;
    return;
  }

  if (currentWindowEntry) windowEntries.push(currentWindowEntry);
  currentWindowEntry = {
    timestamp,
    processName: processName || '(unknown)',
    windowTitle: windowTitle || '(unknown)',
    category: classifyWindow(processName, windowTitle),
    durationMs: 0,
  };
}

function startWindowPolling() {
  let buffer = '';
  try {
    pollProcess = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOW_POLL_SCRIPT]);
  } catch {
    pollProcess = null;
    return;
  }
  pollProcess.stdout.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length < 3) continue;
      const timestamp = Number(parts[0]);
      if (!Number.isFinite(timestamp)) continue;
      handleWindowSample(timestamp, parts[1], parts.slice(2).join('|'));
    }
  });
  pollProcess.on('error', () => { pollProcess = null; });
}

function stopWindowPolling() {
  if (pollProcess) {
    try { pollProcess.kill(); } catch { /* already gone */ }
    pollProcess = null;
  }
  if (currentWindowEntry) {
    currentWindowEntry.durationMs = Date.now() - currentWindowEntry.timestamp;
    windowEntries.push(currentWindowEntry);
    currentWindowEntry = null;
  }
  return windowEntries;
}

// ─── Terminal: PowerShell history (PSReadLine) ─────────────────────────────
// PSReadLine history has no per-command timestamp -- diffed lines are
// bucketed as "sometime during this recording," not precisely sequenced.

function getPsHistoryPath() {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-PSReadlineOption).HistorySavePath'],
      { encoding: 'utf8', timeout: 5000 },
    );
    const p = out.trim();
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

function countLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).length;
  } catch {
    return 0;
  }
}

function snapshotPsHistory() {
  const historyPath = getPsHistoryPath();
  return { historyPath, startLineCount: historyPath ? countLines(historyPath) : 0 };
}

function diffPsHistory(snapshot) {
  if (!snapshot || !snapshot.historyPath) return [];
  try {
    const lines = fs.readFileSync(snapshot.historyPath, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(snapshot.startLineCount);
  } catch {
    return [];
  }
}

// ─── Terminal: opt-in PowerShell transcript (command + output) ────────────
// TicketScribe cannot force an already-open shell to start transcribing
// itself -- this only works for sessions that source a one-time profile
// snippet (see getTranscriptProfileSnippet). It's opt-in because it writes a
// transcript file to disk; the Settings toggle discloses that.
//
// Note: cmd.exe command TEXT is not captured in this build -- there's no
// reliable way to read another process's console history buffer without a
// native console-attach helper. cmd.exe sessions still show up via the
// window-activity source (category "terminal", with dwell time), just
// without the actual commands typed.

function getTranscriptDir() {
  const dir = path.join(os.tmpdir(), 'ticketscribe-transcripts');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* already exists */ }
  return dir;
}

function getTranscriptProfileSnippet() {
  const dir = getTranscriptDir().replace(/\\/g, '\\\\');
  return [
    'if (-not $global:TicketScribeTranscriptStarted) {',
    '  $global:TicketScribeTranscriptStarted = $true',
    `  $dir = "${dir}"`,
    '  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }',
    '  Start-Transcript -Path (Join-Path $dir ("transcript-$PID-" + (Get-Date -Format yyyyMMdd-HHmmss) + ".txt")) -Append | Out-Null',
    '}',
  ].join('\n');
}

function collectTranscripts(startMs, endMs) {
  const dir = getTranscriptDir();
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const results = [];
  for (const name of files) {
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.mtimeMs < startMs || stat.birthtimeMs > endMs) continue;
    try {
      results.push({ file: name, content: fs.readFileSync(full, 'utf8').slice(0, 20000) });
    } catch { /* unreadable transcript, skip */ }
  }
  return results;
}

// ─── Browser: Chrome/Edge history ──────────────────────────────────────────

const CHROME_EPOCH_OFFSET_MS = 11644473600000; // Windows FILETIME epoch (1601-01-01) vs Unix epoch
const chromeTimeToMs = chromeTime => chromeTime / 1000 - CHROME_EPOCH_OFFSET_MS;
const msToChromeTime = ms => (ms + CHROME_EPOCH_OFFSET_MS) * 1000;

const ADMIN_PORTAL_RE = /admin\.microsoft\.com|entra\.microsoft\.com|portal\.azure\.com|outlook\.office\.com\/exchange|endpoint\.microsoft\.com|intune|exchange admin/i;
const KB_DOCS_RE = /docs\.microsoft\.com|learn\.microsoft\.com|support\.microsoft\.com|knowledge.?base|\/kb\//i;
const PSA_URL_RE = /halo/i;

function classifyUrl(url, title) {
  const s = `${url || ''} ${title || ''}`;
  if (ADMIN_PORTAL_RE.test(s)) return 'admin-portal';
  if (PSA_URL_RE.test(s)) return 'psa';
  if (KB_DOCS_RE.test(s)) return 'kb-docs';
  return 'other';
}

function chromiumProfilePaths() {
  const local = process.env.LOCALAPPDATA || '';
  return [
    { name: 'Chrome', path: path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'History') },
    { name: 'Edge', path: path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'History') },
  ].filter(p => fs.existsSync(p.path));
}

function queryBrowserHistory(historyDbPath, startMs, endMs) {
  if (!sqlite3) return [];
  // Copy first: the History file is locked while the browser holds it open.
  const tmpCopy = path.join(os.tmpdir(), `ticketscribe-history-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  let db = null;
  try {
    fs.copyFileSync(historyDbPath, tmpCopy);
    db = new sqlite3(tmpCopy, { readonly: true });
    const rows = db.prepare(
      `SELECT urls.url AS url, urls.title AS title, visits.visit_time AS visit_time
       FROM visits JOIN urls ON visits.url = urls.id
       WHERE visits.visit_time BETWEEN ? AND ?`,
    ).all(msToChromeTime(startMs), msToChromeTime(endMs));
    return rows.map(r => ({
      timestamp: Math.round(chromeTimeToMs(r.visit_time)),
      url: r.url,
      title: r.title,
      category: classifyUrl(r.url, r.title),
    }));
  } catch {
    return [];
  } finally {
    if (db) { try { db.close(); } catch { /* ignore */ } }
    try { fs.unlinkSync(tmpCopy); } catch { /* ignore */ }
  }
}

function collectBrowserHistory(startMs, endMs) {
  if (!sqlite3) return [];
  const profiles = chromiumProfilePaths();
  let all = [];
  for (const p of profiles) {
    all = all.concat(queryBrowserHistory(p.path, startMs, endMs).map(e => ({ ...e, browser: p.name })));
  }
  return all;
}

// ─── Orchestration ──────────────────────────────────────────────────────────

let sessionStart = 0;
let psHistorySnapshot = null;
let transcriptEnabled = false;

function start({ window = true, transcript = false } = {}) {
  sessionStart = Date.now();
  windowEntries = [];
  currentWindowEntry = null;
  psHistorySnapshot = snapshotPsHistory();
  transcriptEnabled = !!transcript;
  if (window) startWindowPolling();
}

function stop({ terminal = true, browserHistory = true } = {}) {
  const sessionEnd = Date.now();
  const windowSamples = stopWindowPolling();

  const events = windowSamples.map(w => ({
    type: 'window',
    timestamp: w.timestamp,
    detail: { processName: w.processName, windowTitle: w.windowTitle, category: w.category, durationMs: w.durationMs },
  }));

  if (terminal) {
    diffPsHistory(psHistorySnapshot).forEach(command => {
      events.push({ type: 'terminal', timestamp: sessionStart, detail: { shell: 'powershell', command } });
    });
    if (transcriptEnabled) {
      collectTranscripts(sessionStart, sessionEnd).forEach(t => {
        events.push({ type: 'terminal', timestamp: sessionStart, detail: { shell: 'powershell-transcript', file: t.file, content: t.content } });
      });
    }
  }

  if (browserHistory) {
    collectBrowserHistory(sessionStart, sessionEnd).forEach(v => {
      events.push({ type: 'browser', timestamp: v.timestamp, detail: { browser: v.browser, url: v.url, title: v.title, category: v.category } });
    });
  }

  events.sort((a, b) => a.timestamp - b.timestamp);
  return events;
}

module.exports = { start, stop, getTranscriptProfileSnippet };
