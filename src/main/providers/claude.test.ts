import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generate } from './claude';
import { SUMMARY_RULES } from './rules';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

describe('claude.generate', () => {
  it('throws without an API key', async () => {
    await expect(generate('', [], '', '')).rejects.toThrow(/No Anthropic API key/);
  });

  it('POSTs the right request shape', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: ' summary ' }] }),
    });
    const frames = [{ timestamp: 1700000000000, dataUrl: 'data:image/jpeg;base64,AAAA', ocrText: 'hi' }];
    const result = await generate('sk-ant-test', frames, '', '');
    expect(result).toBe('summary');

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-ant-test');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');

    const body = JSON.parse(init.body);
    expect(body.model).toBe('claude-sonnet-5');
    const content = body.messages[0].content;
    const textBlocks = content.filter((b: { type: string }) => b.type === 'text');
    expect(textBlocks.some((b: { text: string }) => b.text.includes(SUMMARY_RULES))).toBe(true);
    const imageBlocks = content.filter((b: { type: string }) => b.type === 'image');
    expect(imageBlocks[0].source.data).toBe('AAAA');
  });

  it('throws on a non-ok response', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'bad key' });
    await expect(generate('sk-ant-test', [], '', '')).rejects.toThrow(/Claude 401/);
  });

  it('throws on refusal', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ stop_reason: 'refusal', content: [] }),
    });
    await expect(generate('sk-ant-test', [], '', '')).rejects.toThrow(/declined/);
  });
});
