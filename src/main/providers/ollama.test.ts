import { describe, it, expect, vi, beforeEach } from 'vitest';
import { describeFrame, generateTextSummary, runOllamaPipeline } from './ollama';
import { SUMMARY_RULES } from './rules';

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

describe('describeFrame', () => {
  it('POSTs to /api/generate with the right request shape', async () => {
    mockFetchOnce({ response: ' a description ' });
    const text = await describeFrame('http://localhost:11434', 'llava', 'data:image/jpeg;base64,AAAA', 'some ocr text');
    expect(text).toBe('a description');

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:11434/api/generate');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('llava');
    expect(body.images).toEqual(['AAAA']);
    expect(body.think).toBe(false);
    expect(body.stream).toBe(false);
    expect(body.prompt).toContain('some ocr text');
  });

  it('throws a clear error when Ollama is unreachable', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(describeFrame('http://localhost:11434', 'llava', 'data:image/jpeg;base64,AA', ''))
      .rejects.toThrow(/Could not reach Ollama/);
  });

  it('throws a model-not-found error on 404', async () => {
    mockFetchOnce({}, false, 404);
    await expect(describeFrame('http://localhost:11434', 'llava', 'data:image/jpeg;base64,AA', ''))
      .rejects.toThrow(/was not found/);
  });
});

describe('generateTextSummary', () => {
  it('prompt contains SUMMARY_RULES and the numbered timeline', async () => {
    mockFetchOnce({ response: 'ok' });
    await generateTextSummary('http://localhost:11434', 'llama3', [{ timestamp: 1, text: 'Opened Notepad' }], '', '');
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.prompt).toContain(SUMMARY_RULES);
    expect(body.prompt).toContain('1. Opened Notepad');
  });
});

describe('runOllamaPipeline', () => {
  it('throws when every frame description fails', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));
    await expect(runOllamaPipeline(
      { url: 'http://localhost:11434', vlmModel: 'llava', textModel: 'llama3' },
      [{ timestamp: 1, dataUrl: 'data:image/jpeg;base64,AA', ocrText: '' }],
      '',
      '',
    )).rejects.toThrow();
  });
});
