// @vitest-environment jsdom
//
// scrubText()/findSensitiveWords() are the two redaction gates for TEXT (as
// opposed to redact.test.ts, which covers the pixel-level gate): every OCR
// string and activity-timeline field goes through scrubText() before any
// model sees it, and findSensitiveWords() is what the review stage's
// auto-mask boxes come from. Needs jsdom for localStorage (client-name
// config) -- scrubText/findSensitiveWords don't touch canvas/DOM otherwise.
import { describe, it, expect, beforeEach } from 'vitest';
import { scrubText, scrubEvents, findSensitiveWords, type OcrWord } from './scrub-timeline';
import type { ActivityEvent } from '../../../shared/events';

beforeEach(() => {
  localStorage.clear();
});

function word(text: string): OcrWord {
  return { text, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } };
}

describe('scrubText', () => {
  it('redacts password/pwd/pin/secret assignments but keeps the label', () => {
    expect(scrubText('Password: hunter22')).toBe('Password: [redacted]');
    expect(scrubText('pwd=letmein99')).toBe('pwd: [redacted]');
    expect(scrubText('PIN = 445566')).toBe('PIN: [redacted]');
    expect(scrubText('secret: sshh12345')).toBe('secret: [redacted]');
  });

  it('redacts username/login assignments but keeps the label', () => {
    expect(scrubText('Username: jdoe')).toBe('Username: [redacted]');
    expect(scrubText('login=admin01')).toBe('login: [redacted]');
  });

  it('does not treat a 1-2 char value as a credential (avoids over-matching short words)', () => {
    expect(scrubText('password: ok')).toBe('password: ok');
  });

  it('redacts API-key-shaped tokens', () => {
    expect(scrubText('key is sk-abcdefghijklmnopqrst')).toBe('key is [redacted]');
    expect(scrubText('token pk-abcdefghijklmnopqrst')).toBe('token [redacted]');
    expect(scrubText('AWS key AKIAABCDEFGHIJKLMNOP')).toBe('AWS key [redacted]');
    // Unlike PASSWORD_RE/USERNAME_RE, this alternative's label+separator+value
    // is one combined match with no replacer function, so the whole span
    // (not just the value) is replaced -- the label itself doesn't survive.
    expect(scrubText('see api_key: abcdef123456 above')).toBe('see [redacted] above');
  });

  it('redacts a bare long alphanumeric token (generic secret-shaped string)', () => {
    expect(scrubText('token abcdefghij0123456789ABCDEFGHIJKL')).toBe('token [redacted]');
  });

  it("redacts a GUID-shaped tenant/object ID (via API_KEY_RE's generic token rule, not GUID_RE)", () => {
    // Discovered writing this test, not a regression: API_KEY_RE's bare
    // `[A-Za-z0-9_-]{32,}` catch-all runs before GUID_RE in the chain, and a
    // standard 8-4-4-4-12 GUID is always 36 chars of exactly that character
    // set -- so it's consumed there first. The value still gets redacted
    // ([redacted] rather than [tenant-id]), so this is a labeling quirk, not
    // a leak. GUID_RE is effectively unreachable for real GUIDs today.
    expect(scrubText('tenant 3fa85f64-5717-4562-b3fc-2c963f66afa6 active')).toBe('tenant [redacted] active');
  });

  it('redacts email addresses', () => {
    expect(scrubText('contact jdoe@example.com now')).toBe('contact [email] now');
  });

  it('redacts configured client names, case-insensitively, across multiple names', () => {
    localStorage.setItem('scrubClientNames', 'Acme Corp, Globex');
    expect(scrubText('Ticket for ACME CORP regarding globex outage')).toBe(
      'Ticket for [client] regarding [client] outage',
    );
  });

  it('treats client names as literal strings, not regex (special characters escaped)', () => {
    localStorage.setItem('scrubClientNames', 'Acme (UK)');
    expect(scrubText('Client: Acme (UK) renewal')).toBe('Client: [client] renewal');
  });

  it('leaves text with nothing sensitive untouched', () => {
    expect(scrubText('Rebooted the print server and confirmed connectivity.')).toBe(
      'Rebooted the print server and confirmed connectivity.',
    );
  });

  it('passes through empty/falsy input unchanged', () => {
    expect(scrubText('')).toBe('');
  });
});

describe('scrubEvents', () => {
  it('scrubs text fields on activity-timeline events without touching other fields', () => {
    const events: ActivityEvent[] = [
      {
        type: 'browser',
        timestamp: 1700000000000,
        detail: {
          browser: 'Edge',
          url: 'https://portal.example.com/u/jdoe@example.com',
          title: 'Portal',
          category: 'other',
        },
      },
    ];
    const [scrubbed] = scrubEvents(events);
    expect((scrubbed.detail as { url: string }).url).toBe('https://portal.example.com/u/[email]');
    expect((scrubbed.detail as { browser: string }).browser).toBe('Edge'); // non-text-field, untouched
    expect(scrubbed.timestamp).toBe(1700000000000);
  });

  it('handles null/undefined input', () => {
    expect(scrubEvents(null)).toEqual([]);
    expect(scrubEvents(undefined)).toEqual([]);
  });
});

describe('findSensitiveWords', () => {
  it('flags a self-contained sensitive word regardless of any label (email)', () => {
    const words = [word('contact'), word('jdoe@example.com'), word('please')];
    expect(findSensitiveWords(words).map(w => w.text)).toEqual(['jdoe@example.com']);
  });

  it('flags "Password: hunter2" -> ["Password:", "hunter2"] (value at label+1)', () => {
    const words = [word('Password:'), word('hunter2')];
    expect(findSensitiveWords(words).map(w => w.text)).toEqual(['hunter2']);
  });

  it('flags "Password = hunter2" -> ["Password", "=", "hunter2"] (value at label+2)', () => {
    const words = [word('Password'), word('='), word('hunter2')];
    expect(findSensitiveWords(words).map(w => w.text)).toEqual(['hunter2']);
  });

  it('flags "User name: jdoe" -> ["User", "name:", "jdoe"] (value at label+2, continuation word skipped)', () => {
    const words = [word('User'), word('name:'), word('jdoe')];
    expect(findSensitiveWords(words).map(w => w.text)).toEqual(['jdoe']);
  });

  it('flags "Secret credentials = hnt2" -> value at label+3 (continuation + separator both skipped)', () => {
    const words = [word('Secret'), word('credentials'), word('='), word('hnt2')];
    expect(findSensitiveWords(words).map(w => w.text)).toEqual(['hnt2']);
  });

  it('never flags the label word or the separator token itself', () => {
    const words = [word('Password'), word('='), word('hunter2')];
    const flagged = findSensitiveWords(words).map(w => w.text);
    expect(flagged).not.toContain('Password');
    expect(flagged).not.toContain('=');
  });

  it('does not flag a label with nothing following it', () => {
    const words = [word('Password:')];
    expect(findSensitiveWords(words)).toEqual([]);
  });

  it('flags a configured client name appearing as its own word', () => {
    localStorage.setItem('scrubClientNames', 'Globex');
    const words = [word('ticket'), word('for'), word('Globex')];
    expect(findSensitiveWords(words).map(w => w.text)).toEqual(['Globex']);
  });

  it('returns an empty array for no words / null / undefined', () => {
    expect(findSensitiveWords([])).toEqual([]);
    expect(findSensitiveWords(null)).toEqual([]);
    expect(findSensitiveWords(undefined)).toEqual([]);
  });
});
