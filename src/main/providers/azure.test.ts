import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generate } from './azure';
import { SUMMARY_RULES } from './rules';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

const SETTINGS = { endpoint: 'my-resource.openai.azure.com', deployment: 'gpt-4o-deploy' };

describe('azure.generate', () => {
  it('throws without endpoint/deployment settings', async () => {
    await expect(generate('key', undefined, [], '', '')).rejects.toThrow(/endpoint\/deployment not set/);
    await expect(generate('key', { endpoint: '', deployment: '' }, [], '', '')).rejects.toThrow(/endpoint\/deployment not set/);
  });

  it('throws without an API key', async () => {
    await expect(generate('', SETTINGS, [], '', '')).rejects.toThrow(/No Azure OpenAI API key/);
  });

  it('POSTs the right request shape', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: ' summary ' } }] }),
    });
    const frames = [{ timestamp: 1700000000000, dataUrl: 'data:image/jpeg;base64,AAAA', ocrText: 'hi' }];
    const result = await generate('az-key', SETTINGS, frames, '', '');
    expect(result).toBe('summary');

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://my-resource.openai.azure.com/openai/v1/chat/completions');
    expect(init.headers['api-key']).toBe('az-key');

    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-4o-deploy');
    const content = body.messages[0].content;
    const textBlocks = content.filter((b: { type: string }) => b.type === 'text');
    expect(textBlocks.some((b: { text: string }) => b.text.includes(SUMMARY_RULES))).toBe(true);
    const imageBlocks = content.filter((b: { type: string }) => b.type === 'image_url');
    expect(imageBlocks[0].image_url.url).toBe('data:image/jpeg;base64,AAAA');
  });

  it('normalizes an endpoint without a scheme and strips a trailing slash', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'x' } }] }),
    });
    await generate('az-key', { endpoint: 'my-resource.openai.azure.com/', deployment: 'd' }, [], '', '');
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://my-resource.openai.azure.com/openai/v1/chat/completions');
  });

  it.each([
    [401, /rejected the API key/],
    [403, /access denied/],
    [404, /deployment not found/],
    [429, /rate limit/],
  ])('maps a %i response to a distinct message', async (status, pattern) => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status, text: async () => 'body' });
    await expect(generate('az-key', SETTINGS, [], '', '')).rejects.toThrow(pattern);
  });

  it('maps a content-filter error body to a distinct message', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { code: 'content_filter', message: 'blocked' } }),
    });
    await expect(generate('az-key', SETTINGS, [], '', '')).rejects.toThrow(/content filter/);
  });

  it('maps a 200 response with finish_reason content_filter to a distinct message', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ finish_reason: 'content_filter', message: { content: '' } }] }),
    });
    await expect(generate('az-key', SETTINGS, [], '', '')).rejects.toThrow(/content filter/);
  });

  it('throws a generic message on an unmapped non-ok status', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    await expect(generate('az-key', SETTINGS, [], '', '')).rejects.toThrow(/Azure OpenAI 500/);
  });

  it('throws a network-failure message when fetch itself rejects', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(generate('az-key', SETTINGS, [], '', '')).rejects.toThrow(/Could not reach Azure OpenAI/);
  });
});
