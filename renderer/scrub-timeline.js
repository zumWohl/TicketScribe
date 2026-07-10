// Text-scrubbing pass, applied to OCR text at the source (see app.js) and to
// the assembled activity timeline before any model call -- cloud (Claude) or
// local (Ollama). Window titles and admin-portal URLs routinely carry client
// names and tenant/object IDs; OCR'd screen text routinely carries literal
// credentials someone just typed. This is an MSP handling client data, so
// this runs before generation rather than being an afterthought.
//
// Note the real limit of this pass: it only scrubs TEXT. A screenshot sent
// to a vision model still shows the credential as pixels -- this cannot
// redact what's visually on screen, only what reaches the model as OCR'd or
// typed text (OCR context strings, activity-timeline fields, the raw-OCR
// fallback text). For Ollama that residual exposure stays on-device; for
// Claude, the actual image bytes still leave the device regardless.

const PASSWORD_RE = /\b(pass(?:word)?|pwd|pin|secret)\s*[:=]\s*(\S{3,})/gi;
const USERNAME_RE = /\b(user(?:name)?|login)\s*[:=]\s*(\S{3,})/gi;
const API_KEY_RE = /\b(?:sk|pk)-[A-Za-z0-9]{16,}\b|\bAKIA[0-9A-Z]{16}\b|\bapi[_-]?key\b\s*[:=]\s*(\S{6,})|\b[A-Za-z0-9_-]{32,}\b/gi;
const GUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

function getClientNames() {
  const raw = localStorage.getItem('scrubClientNames') || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function scrubText(text) {
  if (!text) return text;
  let out = text
    .replace(PASSWORD_RE, (_m, keyword) => `${keyword}: [redacted]`)
    .replace(USERNAME_RE, (_m, keyword) => `${keyword}: [redacted]`)
    .replace(API_KEY_RE, '[redacted]')
    .replace(GUID_RE, '[tenant-id]')
    .replace(EMAIL_RE, '[email]');
  for (const name of getClientNames()) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'gi'), '[client]');
  }
  return out;
}

const TEXT_FIELDS = ['windowTitle', 'url', 'title', 'command', 'content'];

function scrubEvent(event) {
  const detail = { ...event.detail };
  for (const field of TEXT_FIELDS) {
    if (detail[field]) detail[field] = scrubText(detail[field]);
  }
  return { ...event, detail };
}

function scrubEvents(events) {
  return (events || []).map(scrubEvent);
}

// ─── Word-level detection (for on-frame redaction) ──────────────────────────
// scrubText() above matches "keyword: value" as one string, which only works
// against flattened OCR text. OCR word boxes split label and value into
// separate tokens (see the credential-dialog layout in the Review & Redact
// design), so a value can't be caught by testing PASSWORD_RE/USERNAME_RE
// against a single word in isolation -- instead this pairs a label word with
// the word immediately after it. API_KEY_RE/GUID_RE/EMAIL_RE and client names
// are self-contained tokens and match a lone word directly, same as in text.
// Deliberately excludes bare "user" here -- OCR commonly splits "username"
// into two words ("User" "name"), and "user" is also the leading word of
// that pair, not a complete label on its own. Bare "user" is handled as a
// two-word case below instead, so it isn't mistaken for a one-word label
// whose "value" would then be the literal word "name".
const KEYWORD_LABEL_RE = /^(pass(?:word)?|pwd|pin|secret|username|login)[:=]?$/i;
const USER_WORD_RE = /^user[:=]?$/i;
const NAME_WORD_RE = /^name[:=]?$/i;

// PASSWORD_RE/USERNAME_RE/API_KEY_RE/GUID_RE are shared /g regexes also used
// by scrubText()'s .replace() calls -- .test() on a /g regex is stateful
// (lastIndex), so it must be reset before every call or matches get skipped.
function testGlobal(re, str) {
  re.lastIndex = 0;
  return re.test(str);
}

function isSensitiveWord(text) {
  if (!text) return false;
  if (testGlobal(API_KEY_RE, text)) return true;
  if (testGlobal(GUID_RE, text)) return true;
  if (testGlobal(EMAIL_RE, text)) return true;
  const lower = text.toLowerCase();
  return getClientNames().some(name => name && lower.includes(name.toLowerCase()));
}

// words: [{ text, bbox }] from runOCR()'s Tesseract word boxes (see app.js).
// Returns the subset that should be masked before the frame is downscaled.
function findSensitiveWords(words) {
  if (!words || words.length === 0) return [];
  const flags = new Array(words.length).fill(false);
  words.forEach((w, i) => { if (isSensitiveWord(w.text)) flags[i] = true; });
  for (let i = 0; i < words.length - 1; i++) {
    // Two-word "User" "name" label -> value is two words later, not "name" itself.
    if (USER_WORD_RE.test(words[i].text) && NAME_WORD_RE.test(words[i + 1].text)) {
      if (i + 2 < words.length) flags[i + 2] = true;
      i += 1; // skip past "name" so it isn't re-tested as its own label below
      continue;
    }
    if (KEYWORD_LABEL_RE.test(words[i].text)) flags[i + 1] = true;
  }
  return words.filter((_, i) => flags[i]);
}

module.exports = { scrubText, scrubEvent, scrubEvents, findSensitiveWords };
