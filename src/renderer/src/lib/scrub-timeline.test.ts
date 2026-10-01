// @vitest-environment jsdom
//
// Differential test: the same inputs through the legacy renderer/scrub-timeline.js
// and the ported scrub-timeline.ts must produce byte-identical output. Covers
// every regex that actually exists in the module (password, username, API
// key, GUID/tenant-id, email, client names) plus the multi-token labelled-value
// cases documented in findSensitiveWords' comment block.
//
// Note: MIGRATION.md's Phase 3 gate text mentions "IPs" as part of the
// corpus, but no IP-address regex exists anywhere in scrub-timeline.js --
// adding one would be a logic change, which this phase explicitly forbids.
// Omitted; recorded in MIGRATION-REPORT.md.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import * as ported from './scrub-timeline';

const require = createRequire(import.meta.url);
const legacy = require('../../../../renderer/scrub-timeline.js');

beforeEach(() => {
  localStorage.clear();
});

describe('scrubText differential corpus', () => {
  const cases = [
    'Password: hunter2',
    'Password = hunter2secretvalue',
    'pwd=myp@ssw0rd!!',
    'username: jdoe',
    'login = jdoe.smith',
    'sk-abcdefghijklmnopqrstuvwxyz123456',
    'AKIAABCDEFGHIJKLMNOP',
    'api_key: abcdef123456',
    '123e4567-e89b-12d3-a456-426614174000',
    'jane.doe@example.com',
    'Contact jane.doe@example.com about ticket 123e4567-e89b-12d3-a456-426614174000',
    'no sensitive content here at all',
  ];

  it.each(cases)('matches legacy output for: %s', text => {
    expect(ported.scrubText(text)).toBe(legacy.scrubText(text));
  });

  it('matches legacy output for client-name scrubbing', () => {
    localStorage.setItem('scrubClientNames', 'Acme Corp, Northwind Finance');
    const text = 'Called ACME CORP about Northwind finance invoice';
    expect(ported.scrubText(text)).toBe(legacy.scrubText(text));
  });

  it('matches legacy output for empty string (falsy passthrough)', () => {
    expect(ported.scrubText('')).toBe(legacy.scrubText(''));
  });
});

describe('scrubEvent/scrubEvents differential', () => {
  it('scrubs every TEXT_FIELDS entry identically', () => {
    const events = [
      { type: 'window', timestamp: 1, detail: { windowTitle: 'Password: hunter2 - Notepad', processName: 'notepad' } },
      { type: 'browser', timestamp: 2, detail: { url: 'https://acme.example.com', title: 'jane.doe@example.com' } },
      { type: 'terminal', timestamp: 3, detail: { command: 'connect --user jdoe --password: hunter2' } },
    ];
    expect(ported.scrubEvents(events as never)).toEqual(legacy.scrubEvents(events));
  });
});

describe('findSensitiveWords differential corpus', () => {
  const bbox = (x0: number) => ({ x0, y0: 0, x1: x0 + 10, y1: 10 });
  const w = (text: string, x0: number) => ({ text, bbox: bbox(x0) });

  const wordSets = [
    [w('Password:', 0), w('hunter2', 1)],
    [w('Password', 0), w('=', 1), w('hunter2', 2)],
    [w('User', 0), w('name:', 1), w('jdoe', 2)],
    [w('Secret', 0), w('credentials', 1), w('=', 2), w('hnt2', 3)],
    [w('Contact', 0), w('jane.doe@example.com', 1), w('now', 2)],
    [w('Tenant', 0), w('123e4567-e89b-12d3-a456-426614174000', 1)],
    [w('nothing', 0), w('sensitive', 1), w('here', 2)],
  ];

  // Not it.each(wordSets): vitest's each auto-spreads an array-of-arrays
  // into multiple callback arguments, which would split each word-list
  // apart instead of passing it as one argument.
  wordSets.forEach((words, i) => {
    it(`matches legacy flagged words for case ${i}: ${words.map(x => x.text).join(' ')}`, () => {
      const portedResult = ported.findSensitiveWords(words as never);
      const legacyResult = legacy.findSensitiveWords(words);
      expect(portedResult).toEqual(legacyResult);
    });
  });
});
