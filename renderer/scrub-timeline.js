// Text-scrubbing pass over the assembled activity timeline, run before any
// cloud call (Claude) -- and, for consistency, the local Ollama path too.
// Window titles and admin-portal URLs routinely carry client names and
// tenant/object IDs; this is an MSP handling client data, so this runs in
// v1 rather than being deferred.

const GUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

function getClientNames() {
  const raw = localStorage.getItem('scrubClientNames') || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function scrubText(text) {
  if (!text) return text;
  let out = text.replace(GUID_RE, '[tenant-id]').replace(EMAIL_RE, '[email]');
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
