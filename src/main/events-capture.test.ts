import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { WINDOW_POLL_SCRIPT } from './events-capture';

// Phase 8: the legacy-vs-ported byte-identity test is gone along with
// main/events-capture.js itself. This standalone correctness test (not a
// differential) stays.
describe('WINDOW_POLL_SCRIPT', () => {
  it('emits at least one well-formed timestamp|process|title line when spawned', async () => {
    const lines: string[] = [];
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOW_POLL_SCRIPT]);

    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? '';
      lines.push(...parts.filter(Boolean));
    });

    await new Promise(resolve => setTimeout(resolve, 3000));
    try { child.kill(); } catch { /* already gone */ }

    expect(lines.length).toBeGreaterThan(0);
    const wellFormed = lines.some(line => {
      const fields = line.split('|');
      if (fields.length < 3) return false;
      return Number.isFinite(Number(fields[0]));
    });
    expect(wellFormed).toBe(true);
  }, 10000);
});
