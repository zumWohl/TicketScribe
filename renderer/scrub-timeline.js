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

module.exports = { scrubText, scrubEvent, scrubEvents };
