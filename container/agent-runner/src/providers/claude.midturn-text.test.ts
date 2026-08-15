import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ClaudeProvider must surface every non-empty assistant text block as a
// 'text' provider event, in stream order, before the turn's result. The SDK's
// final `result` event only carries the LAST assistant text — a complete
// <message to> block composed between tool calls is invisible to the
// poll-loop unless the provider emits it as a text event. Deleting the
// assistant-message branch in claude.ts goes red here.

const sdkMessages: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      for (const m of sdkMessages) yield m;
    })(),
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-midturn-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('assistant text block surfacing', () => {
  it('yields a text event per non-empty assistant text block, before the result', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '<message to="user">mid-turn reply</message>' },
            { type: 'tool_use', name: 'Bash', input: {} },
            { type: 'text', text: '' },
          ],
        },
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'second segment' }] } },
      { type: 'result', subtype: 'success', result: 'final text' },
    );

    const provider = new ClaudeProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });

    const events: { type: string; text?: string | null }[] = [];
    for await (const e of q.events) events.push(e as { type: string; text?: string | null });

    const texts = events.filter((e) => e.type === 'text');
    expect(texts.map((e) => e.text)).toEqual(['<message to="user">mid-turn reply</message>', 'second segment']);
    // Every text event precedes the result event.
    const resultIdx = events.findIndex((e) => e.type === 'result');
    const lastTextIdx = events.map((e) => e.type).lastIndexOf('text');
    expect(resultIdx).toBeGreaterThan(-1);
    expect(lastTextIdx).toBeLessThan(resultIdx);
    expect(events[resultIdx]!.text).toBe('final text');
  });

  it('yields no text events for assistant messages without text blocks', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-2' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
      { type: 'result', subtype: 'success', result: 'done' },
    );

    const provider = new ClaudeProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });

    const events: { type: string }[] = [];
    for await (const e of q.events) events.push(e as { type: string });

    expect(events.filter((e) => e.type === 'text')).toHaveLength(0);
  });
});
