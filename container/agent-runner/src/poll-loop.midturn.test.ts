import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { processQuery } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

// --- Mid-turn <message> block delivery ---
// The SDK's final result carries only the LAST assistant text. A wrapped
// reply composed between tool calls must be delivered from the 'text' event
// stream, deduped against its echo in the final result, and must suppress
// the unwrapped-nudge when the final text is bare.

const CHAT_ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
  taskRun: false,
};

const TASK_ROUTING = {
  platformId: null,
  channelType: null,
  threadId: 'system:tasks:ser-1',
  inReplyTo: 't1',
  taskRun: true,
};

function seedDest(name = 'discord-main', channelType = 'discord', platformId = 'chan-1'): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, name, channelType, platformId);
}

function insertMessage(id: string, kind: string, content: object): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, on_wake, content)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'pending', NULL, 1, 0, ?)`,
    )
    .run(id, kind, JSON.stringify(content));
}

function taskLogRows(): Array<{ text: string }> {
  return (
    getOutboundDb()
      .prepare("SELECT content FROM messages_out WHERE kind = 'task_log' ORDER BY seq")
      .all() as Array<{ content: string }>
  ).map((r) => JSON.parse(r.content) as { text: string });
}

function makeStubQuery(events: AsyncGenerator<ProviderEvent>): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  return {
    pushes,
    query: {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events,
      abort: () => {},
    },
  };
}

describe('mid-turn <message> block delivery', () => {
  it('delivers a complete block from a mid-turn text event immediately', async () => {
    seedDest();
    let outCountBeforeResult = -1;
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: 'Let me check.\n<message to="discord-main">The answer is 4.</message>' };
      // The generator only resumes after the loop consumed the text event —
      // the delivery must already be in messages_out before the result.
      outCountBeforeResult = getUndeliveredMessages().length;
      yield { type: 'result', text: 'wrapped answer already sent above' };
    }
    const { query } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(outCountBeforeResult).toBe(1);
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('The answer is 4.');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
  });

  it('does not deliver the same block twice when the final result echoes it', async () => {
    seedDest();
    const block = '<message to="discord-main">The answer is 4.</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: block };
      yield { type: 'result', text: block };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(getUndeliveredMessages()).toHaveLength(1);
    expect(pushes).toHaveLength(0);
  });

  it('final bare text after a mid-turn delivery does not trigger the unwrapped nudge', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">Sent mid-turn.</message>' };
      yield { type: 'result', text: 'All done here.' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(getUndeliveredMessages()).toHaveLength(1);
    expect(pushes).toHaveLength(0);
  });

  it('still nudges an unwrapped result when no mid-turn block was delivered', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: 'just thinking out loud, no message block here' };
      yield { type: 'result', text: 'bare final text' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('was not delivered');
  });

  it('sanitizes harness tag artifacts from mid-turn deliveries', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">Deploy is done.\n</parameter></message>' };
      yield { type: 'result', text: 'done' };
    }
    const { query } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Deploy is done.');
  });

  it('echo dedup survives a follow-up pushed while the turn is still streaming', async () => {
    seedDest();
    const block = '<message to="discord-main">The answer is 4.</message>';
    const pushes: string[] = [];

    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: block };

      // A follow-up lands while the turn is STILL in flight — the poller
      // pushes it into the open query before the turn's result arrives.
      // The push must not wipe the mid-turn dedup state.
      insertMessage('m2', 'chat', { sender: 'User', text: 'follow-up while busy' });
      const deadline = Date.now() + 5000;
      while (!pushes.some((p) => p.includes('follow-up while busy')) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      // The in-flight turn's result echoes the mid-turn block — one delivery only.
      yield { type: 'result', text: block };

      // The follow-up's own turn: state was reset at the turn boundary, so a
      // fresh block still delivers.
      yield { type: 'text', text: '<message to="discord-main">Re: follow-up.</message>' };
      yield { type: 'result', text: 'sent above' };
    }
    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0].content).text).toBe('The answer is 4.');
    expect(JSON.parse(out[1].content).text).toBe('Re: follow-up.');
    expect(pushes.filter((p) => p.includes('was not delivered'))).toHaveLength(0);
  });

  it('turn-boundary reset: a later turn re-emitting the same block body delivers again', async () => {
    seedDest();
    const block = '<message to="discord-main">The answer is 4.</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      // Turn 1: mid-turn delivery, echoed in the result (one delivery).
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: block };
      yield { type: 'result', text: block };
      // Turn 2: the model legitimately sends the SAME body again. The dedup
      // set was reset at the turn boundary, so this must deliver — stale keys
      // from turn 1 must not swallow a genuine repeat.
      yield { type: 'text', text: block };
      yield { type: 'result', text: 'sent above' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0].content).text).toBe('The answer is 4.');
    expect(JSON.parse(out[1].content).text).toBe('The answer is 4.');
    expect(pushes).toHaveLength(0);
  });

  it('turn-boundary reset: a later bare unwrapped turn still nudges after an earlier mid-turn send', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      // Turn 1: mid-turn delivery; bare final text is scratchpad (no nudge).
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">Sent mid-turn.</message>' };
      yield { type: 'result', text: 'All done here.' };
      // Turn 2: no mid-turn block, bare unwrapped result. The mid-turn sent
      // count was reset at the turn boundary, so the unwrapped-nudge must
      // fire — a stale count from turn 1 would silently suppress it.
      yield { type: 'text', text: 'just thinking out loud, no message block here' };
      yield { type: 'result', text: 'bare final text' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(getUndeliveredMessages()).toHaveLength(1);
    expect(pushes.filter((p) => p.includes('was not delivered'))).toHaveLength(1);
  });

  it('delivers a bare error result even after a mid-turn delivery in the same turn', async () => {
    seedDest();
    const errText = 'Spending limit reached. Add your own key at https://example.com/keys';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">Started on it.</message>' };
      yield { type: 'result', text: errText, isError: true };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0].content).text).toBe('Started on it.');
    expect(JSON.parse(out[1].content).text).toBe(errText);
    expect(pushes).toHaveLength(0);
  });

  it('an error result that only echoes the mid-turn block is not delivered again', async () => {
    seedDest();
    const block = '<message to="discord-main">Partial progress report.</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: block };
      yield { type: 'result', text: block, isError: true };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(getUndeliveredMessages()).toHaveLength(1);
    expect(pushes).toHaveLength(0);
  });

  it('a block that sanitizes to empty is never delivered as a blank message', async () => {
    seedDest();
    const artifactOnly = '<message to="discord-main"></parameter></message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: artifactOnly };
      yield { type: 'result', text: artifactOnly };
    }
    const { query } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('task runs: mid-turn blocks are not delivered (one-door stays closed)', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">digest is ready</message>' };
      yield { type: 'result', text: 'run finished' };
    }
    const { query } = makeStubQuery(events());

    await processQuery(query, TASK_ROUTING, ['t1'], 'claude', undefined, 'prompt', undefined);

    expect(getUndeliveredMessages().filter((m) => m.kind === 'chat')).toHaveLength(0);
    const logs = taskLogRows();
    expect(logs).toHaveLength(1);
    expect(logs[0].text).toBe('run finished');
  });
});

describe('mock provider mid-turn text events', () => {
  it('emits configured text events before each result', async () => {
    const provider = new MockProvider(
      {},
      (prompt) => `Re: ${prompt}`,
      (prompt) => [`segment about ${prompt}`],
    );
    const query = provider.query({ prompt: 'Hi', cwd: '/tmp' });
    setTimeout(() => query.end(), 50);

    const events: Array<{ type: string; text?: string | null }> = [];
    for await (const event of query.events) {
      events.push(event);
    }

    const textIdx = events.findIndex((e) => e.type === 'text');
    const resultIdx = events.findIndex((e) => e.type === 'result');
    expect(textIdx).toBeGreaterThan(-1);
    expect(textIdx).toBeLessThan(resultIdx);
    expect(events[textIdx].text).toBe('segment about Hi');
    expect(events[resultIdx].text).toBe('Re: Hi');
  });

  it('emits no text events when no factory is configured', async () => {
    const provider = new MockProvider({}, () => 'ok');
    const query = provider.query({ prompt: 'Hi', cwd: '/tmp' });
    setTimeout(() => query.end(), 50);

    const events: Array<{ type: string }> = [];
    for await (const event of query.events) {
      events.push(event);
    }
    expect(events.filter((e) => e.type === 'text')).toHaveLength(0);
  });
});
