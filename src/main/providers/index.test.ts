import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Unit-tests run under plain Node (vitest), not a real Electron process, so
// the 'electron' package itself must be stubbed -- its real main-process APIs
// (nativeImage, app, safeStorage) only exist inside Electron.
vi.mock('electron', () => ({
  nativeImage: {
    createFromDataURL: (dataUrl: string) => {
      const match = /size=(\d+)x(\d+)/.exec(dataUrl);
      const width = match ? Number(match[1]) : 100;
      const height = match ? Number(match[2]) : 100;
      return { getSize: () => ({ width, height }) };
    },
  },
  app: { getPath: () => '' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));

const { generate } = await import('./index');

beforeEach(() => {
  delete process.env.CARDONETCAPTURE_TEST_PROVIDER;
});
afterEach(() => {
  delete process.env.CARDONETCAPTURE_TEST_PROVIDER;
});

describe('generate: image size guard (decision: proves downscale ran)', () => {
  it('rejects a frame whose long edge exceeds MODEL_IMAGE_MAX_DIMENSION', async () => {
    await expect(generate({
      provider: 'echo',
      frames: [{ timestamp: 0, dataUrl: 'data:image/jpeg;size=2000x1000,xx', ocrText: '' }],
      activityTimelineText: '',
      templateContent: '',
    })).rejects.toThrow(/exceeds the 1280px/);
  });

  it('allows a frame within the cap', async () => {
    process.env.CARDONETCAPTURE_TEST_PROVIDER = 'echo';
    const result = await generate({
      provider: 'echo',
      frames: [{ timestamp: 0, dataUrl: 'data:image/jpeg;size=1280x720,xx', ocrText: '' }],
      activityTimelineText: 'hello',
      templateContent: '',
    });
    expect(result).toContain('1 frame');
  });
});

describe('generate: claude dispatch (routed through Azure)', () => {
  const ENV_KEYS = ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_KEY'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    ENV_KEYS.forEach(k => delete process.env[k]);
  });
  afterEach(() => {
    ENV_KEYS.forEach(k => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
  });

  it('reaches azure.generate and surfaces its missing-settings error when env vars are unset', async () => {
    await expect(generate({
      provider: 'claude',
      frames: [],
      activityTimelineText: '',
      templateContent: '',
    })).rejects.toThrow(/endpoint\/deployment not set/);
  });
});

describe('generate: echo provider (decision 10)', () => {
  it('is unreachable without CARDONETCAPTURE_TEST_PROVIDER=echo', async () => {
    await expect(generate({
      provider: 'echo',
      frames: [],
      activityTimelineText: '',
      templateContent: '',
    })).rejects.toThrow(/not enabled/);
  });

  it('returns a deterministic summary when enabled', async () => {
    process.env.CARDONETCAPTURE_TEST_PROVIDER = 'echo';
    const result = await generate({
      provider: 'echo',
      frames: [
        { timestamp: 0, dataUrl: 'data:image/jpeg;size=100x100,xx', ocrText: '' },
        { timestamp: 1, dataUrl: 'data:image/jpeg;size=100x100,xx', ocrText: '' },
      ],
      activityTimelineText: '12345',
      templateContent: '',
    });
    expect(result).toBe('- echo: 2 frame(s), 5 activity-timeline char(s)');
  });
});
