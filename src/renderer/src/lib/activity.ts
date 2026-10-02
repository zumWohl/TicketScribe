// Activity timeline text formatting -- 1:1 port of app.js's
// formatDuration/formatActivityEvent/buildActivityTimelineText, unchanged.
import type { ActivityEvent } from '../../../shared/events';

export function formatDuration(ms: number): string {
  const s = Math.round((ms || 0) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

export function formatActivityEvent(e: ActivityEvent): string {
  const t = new Date(e.timestamp).toLocaleTimeString();
  if (e.type === 'window') {
    const d = e.detail as { processName: string; windowTitle: string; category: string; durationMs: number };
    return `${t} (${formatDuration(d.durationMs)}) [${d.category}] ${d.windowTitle} (${d.processName})`;
  }
  if (e.type === 'terminal') {
    const d = e.detail as { shell: string; command?: string; file?: string; content?: string };
    if (d.shell === 'powershell-transcript') {
      return `${t} [terminal transcript: ${d.file}]\n${d.content}`;
    }
    return `${t} [terminal] ${d.command}`;
  }
  if (e.type === 'browser') {
    const d = e.detail as { category: string; title?: string; url: string; browser: string };
    return `${t} [${d.category}] ${d.title || d.url} (${d.browser})`;
  }
  return `${t} ${JSON.stringify(e.detail)}`;
}

export function buildActivityTimelineText(events: ActivityEvent[] | null | undefined): string {
  if (!events || events.length === 0) return '';
  return events.map(formatActivityEvent).join('\n');
}
