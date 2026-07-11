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
// against flattened OCR text. OCR word boxes split a labelled credential into
// separate tokens, and -- critically -- it also splits the SEPARATOR into its
// own token. So the value is NOT reliably "the next word after the label":
//   "Password: hunter2"           -> ["Password:", "hunter2"]          (value +1)
//   "Password = hunter2"          -> ["Password", "=", "hunter2"]      (value +2)
//   "User name: jdoe"             -> ["User", "name:", "jdoe"]         (value +2)
//   "Secret credentials = hnt2"   -> ["Secret", "credentials", "=", "hnt2"] (+3)
// Rather than special-casing each shape, we walk forward from a label word and
// skip any run of (a) continuation label words ("name", "credentials", ...) and
// (b) punctuation-only separator tokens (":", "=", "-", "|", dashes, or runs of
// them) to land on the first real token -- the value. API_KEY_RE/GUID_RE/
// EMAIL_RE and client names are self-contained and still match a lone word
// directly via isSensitiveWord().

// A word that STARTS a sensitive label. A separator glued onto the label
// ("Password:", "Password=", "Secret-") is tolerated by the trailing class.
const LABEL_WORD_RE = /^(pass(?:word)?|pwd|pin|secret|username|login|user)[:=\-–—|]*$/i;
// A word that CONTINUES a multi-word label rather than being the value
// ("User" "name", "Secret" "credentials"). Only ever consumed after a label
// word, so it can't cause a false positive on its own.
const LABEL_CONT_RE = /^(name|names|credential|credentials|key|keys|token|tokens|id|phrase|code)[:=\-–—|]*$/i;
// A token that is nothing but separator punctuation between a label and its
// value. A run ("::", ":=", "->", "--") collapses to a single separator.
const SEPARATOR_TOKEN_RE = /^[:=\-–—|>»]+$/;
function isSeparatorToken(text) { return SEPARATOR_TOKEN_RE.test((text || '').trim()); }

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
  // 1) Self-contained sensitive tokens flag themselves, regardless of any label.
  words.forEach((w, i) => { if (isSensitiveWord(w.text)) flags[i] = true; });
  // 2) Labelled values: <label word> [continuation label words] [separator
  //    tokens] <value>. Skip continuation + separator tokens so the mask lands
  //    on the value itself -- never on a "=" / ":" separator or a label word.
  for (let i = 0; i < words.length; i++) {
    if (!LABEL_WORD_RE.test(words[i].text)) continue;
    let j = i + 1;
    while (j < words.length && (isSeparatorToken(words[j].text) || LABEL_CONT_RE.test(words[j].text))) {
      j++;
    }
    if (j < words.length && !isSeparatorToken(words[j].text)) flags[j] = true;
    i = j; // resume after the value (the for-loop's i++ moves past it)
  }
  return words.filter((_, i) => flags[i]);
}

module.exports = { scrubText, scrubEvent, scrubEvents, findSensitiveWords };
