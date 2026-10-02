// Covers the window-poll crash supervision added alongside this test: a
// crashed poll process respawns up to MAX_POLL_RESTARTS times, then reports
// "degraded" instead of silently losing window-activity data for the rest
// of the recording. child_process is mocked so this runs fast and
// deterministically, without spawning real PowerShell -- kept in its own
// file because the mock is module-scoped and would break
// events-capture.test.ts's real-spawn WINDOW_POLL_SCRIPT test.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(() => ''),
}));

import { spawn } from 'child_process';
import * as eventsCapture from './events-capture';

function makeFakeChild(): any {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('window-poll crash supervision', () => {
  let children: any[];

  beforeEach(() => {
    children = [];
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReset();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const c = makeFakeChild();
      children.push(c);
      return c;
    });
    eventsCapture.setDegradedHandler(null);
  });

  it('respawns on unexpected exit up to the cap, then reports degraded and stops retrying', () => {
    const messages: string[] = [];
    eventsCapture.setDegradedHandler(m => messages.push(m));

    eventsCapture.start({ window: true });
    expect(spawn).toHaveBeenCalledTimes(1);

    children[0].emit('exit');
    children[1].emit('exit');
    children[2].emit('exit');
    expect(spawn).toHaveBeenCalledTimes(4); // 1 initial + 3 respawns
    expect(messages).toHaveLength(0); // still within the cap, no degraded report yet

    children[3].emit('exit'); // exceeds the cap
    expect(spawn).toHaveBeenCalledTimes(4); // no further respawn
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/stopped after 3 restart attempts/);

    eventsCapture.stop({ terminal: false, browserHistory: false });
  });

  it('does not respawn after stop() has already been called', () => {
    eventsCapture.start({ window: true });
    eventsCapture.stop({ terminal: false, browserHistory: false });

    children[0].emit('exit'); // simulates the just-killed process finishing its exit
    expect(spawn).toHaveBeenCalledTimes(1); // no respawn -- recording is over
  });

  it('shutdown() kills an active poll process outright', () => {
    eventsCapture.start({ window: true });
    eventsCapture.shutdown();
    expect(children[0].kill).toHaveBeenCalled();

    children[0].emit('exit');
    expect(spawn).toHaveBeenCalledTimes(1); // no respawn after shutdown either
  });
});
