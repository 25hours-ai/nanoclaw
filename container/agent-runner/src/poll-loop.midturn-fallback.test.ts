import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

// Adversarial verification of the structural-strip premise: "any complete
// deliverable <message> block in the result text was already streamed as a
// text event, hence already delivered at the mid-turn door."
//
// The premise is an SDK-behavioral claim, NOT enforceable from provider code:
// ClaudeProvider's result event takes its text verbatim from the SDK's own
// `result` / `errors[]` fields (providers/claude.ts), while text events come
// from assistant messages — two independent sources. These tests construct
// the divergence cases and pin the stateless fallback that makes them safe:
// the strip is armed only when the turn delivered at least one block
// mid-turn (midTurnSent > 0); a turn with zero mid-turn deliveries keeps the
// result door fully live. The fallback cannot double-deliver — midTurnSent
// === 0 means nothing was sent that a result-door send could duplicate.

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

const CHAT_ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
  taskRun: false,
};

function seedDest(name = 'discord-main', channelType = 'discord', platformId = 'chan-1'): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, name, channelType, platformId);
}

function removeDest(name: string): void {
  getInboundDb().prepare('DELETE FROM destinations WHERE name = ?').run(name);
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

function deliveredTexts(): string[] {
  return getUndeliveredMessages()
    .filter((m) => m.kind === 'chat')
    .map((m) => (JSON.parse(m.content) as { text: string }).text);
}

// ── A4: SDK-drift guard (the catastrophic total-silence case) ──

describe('result-door fallback when the turn delivered nothing mid-turn', () => {
  it('capability=true but ZERO text events: a deliverable result block is delivered, not stripped', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // SDK drift: the capability says text streams, but this turn emitted
      // none — the result is the only carrier of the reply. Stripping it
      // would be total silence with no log trail the user ever sees.
      yield { type: 'result', text: '<message to="discord-main">Only exists in the result.</message>' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['Only exists in the result.']);
    expect(pushes).toHaveLength(0);
  });

  it('streamed text WITHOUT deliverable blocks + result WITH a block: fallback delivers once', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: 'thinking out loud, nothing wrapped yet' };
      yield { type: 'result', text: '<message to="discord-main">The reply.</message>' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['The reply.']);
    expect(pushes).toHaveLength(0);
  });

  it('fallback resets per turn: a later drift turn still delivers after an earlier streamed turn', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      // Turn 1: normal streaming — strip armed, one delivery.
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">turn one</message>' };
      yield { type: 'result', text: '<message to="discord-main">turn one</message>' };
      // Turn 2: drift — no text events. midTurnSent was reset at the turn
      // boundary, so the fallback must arm again.
      yield { type: 'result', text: '<message to="discord-main">turn two</message>' };
    }
    const { query } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['turn one', 'turn two']);
  });
});

// ── A2: multi-segment turns and partial-overlap results ──

describe('multi-segment turns: strip against partial and full overlap', () => {
  it('result repeating ALL segments blocks (not just the last) strips them all — each already delivered', async () => {
    seedDest();
    const a = '<message to="discord-main">segment A</message>';
    const b = '<message to="discord-main">segment B</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: a };
      yield { type: 'text', text: b };
      yield { type: 'result', text: `${a}\n${b}` };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['segment A', 'segment B']);
    expect(pushes).toHaveLength(0);
  });

  it('result carrying only the LAST segment: earlier deliveries stand, the repeat is stripped', async () => {
    seedDest();
    const a = '<message to="discord-main">segment A</message>';
    const b = '<message to="discord-main">segment B</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: a };
      yield { type: 'text', text: b };
      yield { type: 'result', text: b };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['segment A', 'segment B']);
    expect(pushes).toHaveLength(0);
  });
});

// ── A3: interrupted / error turns ──

describe('error and interrupted turns', () => {
  it('error result whose block never streamed (errors[] shape), nothing sent mid-turn: fallback delivers', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: 'partial progress narration, unwrapped' };
      // The claude provider builds error-result text from the SDK's errors[]
      // field — content that NEVER streamed as assistant text. If it carries
      // a deliverable block, stripping it would silently eat the notice.
      yield { type: 'result', text: '<message to="discord-main">Run aborted: quota.</message>', isError: true };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['Run aborted: quota.']);
    expect(pushes).toHaveLength(0);
  });

  it('a stream that throws after a mid-turn delivery: the delivered row survives, processQuery rejects', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">Sent before the crash.</message>' };
      throw new Error('SDK stream died');
    }
    const { query } = makeStubQuery(events());

    await expect(
      processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true),
    ).rejects.toThrow('SDK stream died');

    // The mid-turn write is durable — an interrupted turn cannot claw it back.
    expect(deliveredTexts()).toEqual(['Sent before the crash.']);
  });
});

// ── B: predicate timing — destinations changing intra-turn ──

describe('destination set changes between stream time and result time', () => {
  it('dest unknown at stream time but present at result time, nothing else delivered: fallback delivers', async () => {
    // Destinations are live-queried from inbound.db (the host writes the
    // table on demand, mid-session). A block skipped at the mid-turn door for
    // unknown destination must not be strip-dropped at the result once the
    // destination exists — with zero mid-turn deliveries the strip stays
    // unarmed and the result door delivers.
    const block = '<message to="discord-main">Hello, new channel.</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: block }; // door: unknown dest → skipped
      seedDest(); // host wires the destination mid-turn
      yield { type: 'result', text: block };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['Hello, new channel.']);
    expect(pushes).toHaveLength(0);
  });

  it('KNOWN RESIDUAL (pinned): dest appears late while ANOTHER block already delivered — the late block is stripped', async () => {
    // Stateless bound, accepted by design: once any block delivered mid-turn
    // the strip is armed for the whole result, and without content-keyed
    // state (or an outbound-DB consult per block) the result door cannot
    // tell "already delivered at the door" from "skipped at the door for a
    // reason that no longer holds". Reaching this shape requires a
    // destination write landing inside the sub-second window between the
    // last streamed segment and the result, in a turn that also delivered
    // another block. If this trade-off is ever revisited, the exact fix is a
    // per-block messages_out lookup (rows written since the turn started,
    // same platform/channel, same content) instead of the structural strip.
    seedDest('discord-main');
    const known = '<message to="discord-main">to the known channel</message>';
    const late = '<message to="late-dest">to the late channel</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: `${known}\n${late}` }; // known delivers; late skipped (unknown)
      seedDest('late-dest', 'discord', 'chan-2'); // appears inside the window
      yield { type: 'result', text: `${known}\n${late}` };
    }
    const { query } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    // Only the known-at-stream-time block goes out; the late one is stripped.
    expect(deliveredTexts()).toEqual(['to the known channel']);
  });

  it('dest removed between stream and result: the delivered block is not re-sent and no nudge fires', async () => {
    seedDest();
    const block = '<message to="discord-main">delivered before removal</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: block }; // delivers
      removeDest('discord-main');
      yield { type: 'result', text: block }; // result-door: unknown dest → dropped-note, no strip needed
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['delivered before removal']);
    expect(pushes.filter((p) => p.includes('was not delivered'))).toHaveLength(0);
  });
});

// ── HALF-MESSAGES: blocks split across streamed text events ──
//
// The claude provider emits ONE text event per assistant message (text blocks
// joined) — a <message> block can still open in one assistant message and
// close in a later one when a tool call rides between them. The mid-turn door
// parses each event independently and keeps NO cross-event buffer, so a
// cross-event block is never delivered mid-turn. Under the SDK premise the
// result repeats only the LAST message's text, so the block is incomplete
// there too — the wrap-nudge is the recovery path. If drift ever hands the
// result a healed (complete) copy, the midTurnSent===0 fallback delivers it.

describe('half-messages: block split across streamed text events', () => {
  it('no cross-event buffering: split block undelivered mid-turn; a tail-only result fires the wrap-nudge', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">part one, ' };
      yield { type: 'text', text: 'part two</message>' };
      // SDK premise: result = last assistant text = the tail, incomplete.
      yield { type: 'result', text: 'part two</message>' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    // Nothing half-formed is ever delivered…
    expect(deliveredTexts()).toEqual([]);
    // …and the turn is not silent: the wrap-nudge asks the agent to re-send.
    expect(pushes.filter((p) => p.includes('was not delivered'))).toHaveLength(1);
  });

  it('healing drift: block incomplete in every streamed event but complete in the result → fallback delivers once', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">first half, ' };
      yield { type: 'text', text: 'second half</message>' };
      // Drift shape: the result carries the concatenation. No streamed event
      // parsed a complete block (midTurnSent === 0), so the strip must stay
      // unarmed and the result door must deliver — stripping here was the
      // total-loss case.
      yield { type: 'result', text: '<message to="discord-main">first half, second half</message>' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['first half, second half']);
    expect(pushes).toHaveLength(0);
  });

  it('never-completed block alongside a delivered block: fragment stays scratchpad, no nudge, no loss of anything complete', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">complete reply</message>' };
      yield { type: 'text', text: '<message to="discord-main">opened but never closed…' };
      yield { type: 'result', text: '' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['complete reply']);
    // A block was delivered this turn — the unfinished fragment is treated as
    // scratchpad, not as an undelivered reply.
    expect(pushes.filter((p) => p.includes('was not delivered'))).toHaveLength(0);
  });
});

// ── Cross-segment echo guard (live-captured: SDK battery s03) ──
//
// The model, after a trailing tool call, often re-emits the ALREADY-SENT
// block verbatim as its final text — which streams as its own text event.
// The door consults the outbound DB over the frame-local seq window
// (turnStartSeq, segStartSeq] to recognize the repeat; no in-process content
// ledger. Intra-segment doubles and cross-turn repeats stay deliverable.

describe('cross-segment echo guard', () => {
  it('a later segment re-emitting the identical block delivers once (s03 recording shape)', async () => {
    seedDest();
    const block = '<message to="discord-main">✅ Deploy is done.</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: block }; // composed + delivered before the tool call
      yield { type: 'text', text: block }; // final text: verbatim echo after the tool call
      yield { type: 'result', text: block }; // result === last segment (live invariant)
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['✅ Deploy is done.']);
    expect(pushes).toHaveLength(0);
  });

  it('two identical blocks in ONE segment are an explicit double-send and both deliver (s09 shape)', async () => {
    seedDest();
    const twice =
      '<message to="discord-main">backup finished</message>\n\n<message to="discord-main">backup finished</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: twice };
      yield { type: 'result', text: twice };
    }
    const { query } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['backup finished', 'backup finished']);
  });

  it('the same body to a DIFFERENT destination is not an echo', async () => {
    seedDest('discord-main');
    seedDest('ops-log', 'slack', 'chan-ops');
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">capture test</message>' };
      yield { type: 'text', text: '<message to="ops-log">capture test</message>' };
      yield { type: 'result', text: '' };
    }
    const { query } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['capture test', 'capture test']);
  });

  it('the window closes at the turn boundary: the next turn may genuinely repeat the body', async () => {
    seedDest();
    const block = '<message to="discord-main">The answer is 4.</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: block };
      yield { type: 'result', text: block };
      // Turn 2: same body again, on purpose. Must deliver.
      yield { type: 'text', text: block };
      yield { type: 'result', text: 'sent above' };
    }
    const { query } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['The answer is 4.', 'The answer is 4.']);
  });
});

// ── C: failure ordering — mid-turn outbound write fails ──

describe('mid-turn delivery write failure', () => {
  it('fails the turn loudly: processQuery rejects, the stream never reaches its result, nothing is strip-dropped', async () => {
    seedDest();
    let reachedResult = false;
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // Break the outbound DB before the delivery attempt — the next
      // writeMessageOut throws (fresh prepare per call, so the rename bites).
      getOutboundDb().exec('ALTER TABLE messages_out RENAME TO messages_out_broken');
      yield { type: 'text', text: '<message to="discord-main">will fail to write</message>' };
      reachedResult = true;
      yield { type: 'result', text: '<message to="discord-main">will fail to write</message>' };
    }
    const { query } = makeStubQuery(events());

    await expect(
      processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true),
    ).rejects.toThrow();

    // The turn died at the failed write: the result was never processed, so
    // the block was NOT silently stripped as "already delivered" — the
    // caller's error path (runPollLoop) surfaces the failure to the user.
    expect(reachedResult).toBe(false);
    getOutboundDb().exec('ALTER TABLE messages_out_broken RENAME TO messages_out');
    expect(deliveredTexts()).toEqual([]);
  });
});

// ── D: result-door handling for blocks the mid-turn door skips ──

describe('capability=true keeps base result-door handling for door-skipped blocks', () => {
  it('unknown destination at both doors: dropped with the wrap-nudge, never silently stripped', async () => {
    // No destination seeded at all.
    const block = '<message to="nobody-home">is anyone there?</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: block };
      yield { type: 'result', text: block };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual([]);
    // The drop lands in the scratchpad and the turn counts as undelivered —
    // the nudge (listing real destinations) is the base-behavior surface.
    expect(pushes.filter((p) => p.includes('was not delivered'))).toHaveLength(1);
  });
});
