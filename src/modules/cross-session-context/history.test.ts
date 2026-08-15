/**
 * `ncl sessions history` handler tests: merge/format, limit, and — the
 * critical one — self-scoping (custom ops bypass the dispatcher's generic
 * scope filter, so cross-group agents must get "session not found" here).
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cross-session-history' };
});

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder, writeOutboundDirect, writeSessionMessage } from '../../session-manager.js';
import type { CallerContext } from '../../cli/frame.js';
import { sessionHistory } from './history.js';

const TEST_DIR = '/tmp/nanoclaw-test-cross-session-history';
const AG = 'ag-hist';
const SESS = 'sess-hist';

const HOST: CallerContext = { caller: 'host' };
const OWN_AGENT: CallerContext = { caller: 'agent', sessionId: 'sess-x', agentGroupId: AG, messagingGroupId: 'mg-x' };
const FOREIGN_AGENT: CallerContext = {
  caller: 'agent',
  sessionId: 'sess-y',
  agentGroupId: 'ag-other',
  messagingGroupId: 'mg-y',
};

function writeInbound(id: string, timestamp: string, text: string, sender = 'Gavriel'): void {
  writeSessionMessage(AG, SESS, {
    id,
    kind: 'chat',
    timestamp,
    platformId: 'D1',
    channelType: 'slack',
    threadId: null,
    content: JSON.stringify({ text, sender, senderId: 'slack:U1' }),
  });
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({
    id: AG,
    name: 'Pixel',
    folder: 'pixel',
    agent_provider: null,
    created_at: '2026-08-01T00:00:00.000Z',
  });
  createSession({
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-08-01T00:00:00.000Z',
  });
  initSessionFolder(AG, SESS);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('sessionHistory', () => {
  it('merges inbound + outbound chronologically as pipe-separated lines', () => {
    writeInbound('in-1', '2026-08-01T10:00:00.000Z', 'hello there');
    writeInbound('in-2', '2026-08-01T10:02:00.000Z', 'second message');
    // writeOutboundDirect stamps now() — always sorts after the fixed 2026 stamps.
    writeOutboundDirect(AG, SESS, {
      id: 'out-1',
      kind: 'chat',
      platformId: 'D1',
      channelType: 'slack',
      threadId: null,
      content: JSON.stringify({ text: 'agent reply' }),
    });

    const lines = sessionHistory({ id: SESS }, HOST).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('2026-08-01T10:00:00.000Z|in|chat|Gavriel|hello there');
    expect(lines[1]).toBe('2026-08-01T10:02:00.000Z|in|chat|Gavriel|second message');
    const out = lines[2].split('|');
    expect(out[1]).toBe('out');
    expect(out[2]).toBe('chat');
    expect(out[3]).toBe('Pixel'); // agent group name as outbound sender
    expect(out[4]).toBe('agent reply');
  });

  it('applies --limit keeping the NEWEST rows', () => {
    for (let i = 0; i < 5; i++) {
      writeInbound(`in-${i}`, `2026-08-01T10:0${i}:00.000Z`, `msg ${i}`);
    }
    const lines = sessionHistory({ id: SESS, limit: 2 }, HOST).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('msg 3');
    expect(lines[1]).toContain('msg 4');
  });

  it('sanitizes newlines and pipes out of the text cell', () => {
    writeInbound('in-1', '2026-08-01T10:00:00.000Z', 'line one\nline two | with pipe');
    const line = sessionHistory({ id: SESS }, HOST);
    expect(line.split('\n')).toHaveLength(1);
    expect(line.endsWith('line one line two / with pipe')).toBe(true);
  });

  it('self-scopes: a cross-group agent gets "session not found", same as a bogus id', () => {
    writeInbound('in-1', '2026-08-01T10:00:00.000Z', 'private');
    expect(() => sessionHistory({ id: SESS }, FOREIGN_AGENT)).toThrow(`session not found: ${SESS}`);
    expect(() => sessionHistory({ id: 'sess-nope' }, FOREIGN_AGENT)).toThrow('session not found: sess-nope');
    expect(() => sessionHistory({ id: 'sess-nope' }, HOST)).toThrow('session not found: sess-nope');
  });

  it('allows the owning agent group and the host', () => {
    writeInbound('in-1', '2026-08-01T10:00:00.000Z', 'visible');
    expect(sessionHistory({ id: SESS }, OWN_AGENT)).toContain('visible');
    expect(sessionHistory({ id: SESS }, HOST)).toContain('visible');
  });
});
