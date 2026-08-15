/**
 * Cross-session context — accumulate fan-out.
 *
 * Copies triggering user messages (router hook) and the agent's own delivered
 * user-facing messages (delivery hook) into sibling sessions of the same agent
 * group as trigger=0 rows with channel_type 'session-echo'. Echo rows ride
 * along as ambient context with the next real trigger — they never wake a
 * container, never provide reply routing (thread_id NULL; the formatter's
 * reply-routing extraction skips 'session-echo'), and are never themselves
 * fanned (loop guard: fan entries reject 'session-echo' rows, and fan writes
 * go through writeSessionMessage, which never re-enters routeInbound).
 *
 * Audience rule (pragmatic form — membership tracking lands later):
 *   - task sessions of the group are ALWAYS targets, from DM and room sources
 *   - room source → additionally the group's DM sessions
 *   - DM source  → task sessions, plus sibling sessions of the SAME messaging
 *     group (parallel conversation-threads of that same DM — same audience,
 *     so trivially safe). DM content never enters rooms or OTHER DMs.
 *   - room→room: not in v1 (not even same-mg room threads); task sessions are
 *     never a SOURCE
 */
import {
  getMessagingGroup,
  getMessagingGroupByPlatform,
  getMessagingGroupForOwnDestination,
} from '../../db/messaging-groups.js';
import { getSessionsByAgentGroup, isTaskThread } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, MessagingGroup, Session } from '../../types.js';
import { ECHO_CHANNEL_TYPE, ECHO_SIBLING_SURFACE, ECHO_TEXT_MAX_CHARS } from './config.js';

export type EchoSurface = 'dm' | 'room';

/** Surface values that appear on the wire in echo.{surface}: the two source
 *  surfaces plus the same-mg sibling-thread marker. */
export type EchoWireSurface = EchoSurface | typeof ECHO_SIBLING_SURFACE;

/** Inbound kinds that are real chat traffic. Everything else (task, system,
 *  approval plumbing) never fans. */
const CHAT_KINDS = new Set(['chat', 'chat-sdk']);

/** Head-truncate to the cap, appending '…' when cut (contract: ≤500 chars). */
export function truncateEchoText(text: string): string {
  return text.length <= ECHO_TEXT_MAX_CHARS ? text : `${text.slice(0, ECHO_TEXT_MAX_CHARS)}…`;
}

/** Echo-row id: namespaced by target session so the same source message can
 *  land in every sibling inbound.db without PK collisions (contract shape). */
export function echoRowId(origMessageId: string, targetSessionId: string): string {
  return `${origMessageId}:echo:${targetSessionId}`;
}

/** Human label for the source conversation, e.g. '#Pixel room' / 'DM with Gavriel'. */
export function buildEchoLabel(
  mg: Pick<MessagingGroup, 'name' | 'platform_id' | 'is_group'>,
  senderName?: string | null,
): string {
  if (mg.is_group === 1) return `#${mg.name ?? mg.platform_id} room`;
  const who = mg.name ?? senderName;
  return who ? `DM with ${who}` : `DM (${mg.platform_id})`;
}

/** Human label for a same-mg sibling-thread echo — the target session is
 *  another conversation-thread of the very same DM, so the label reads as
 *  "another conversation with <who>" rather than naming a different surface. */
export function buildSiblingEchoLabel(
  mg: Pick<MessagingGroup, 'name' | 'platform_id' | 'is_group'>,
  senderName?: string | null,
): string {
  const who = mg.is_group === 0 ? (mg.name ?? senderName) : null;
  return who ? `another conversation with ${who}` : `another conversation in ${buildEchoLabel(mg, senderName)}`;
}

export interface EchoTargetCandidate {
  id: string;
  status: string;
  messaging_group_id: string | null;
  thread_id: string | null;
}

/**
 * Pure audience rule. `isDmMessagingGroup` resolves whether a candidate's
 * messaging group is a DM (is_group=0) — injected so the rule stays testable
 * without a central DB. `sourceMessagingGroupId` is the source conversation's
 * messaging group, used to admit same-mg sibling threads for DM sources.
 */
export function selectEchoTargets<T extends EchoTargetCandidate>(
  candidates: T[],
  sourceSessionId: string,
  sourceSurface: EchoSurface,
  sourceMessagingGroupId: string | null,
  isDmMessagingGroup: (messagingGroupId: string) => boolean,
): T[] {
  return candidates.filter((s) => {
    if (s.id === sourceSessionId || s.status !== 'active') return false;
    // System sessions: task sessions are always in the audience; any other
    // messaging-group-less session (a2a targets, future system threads) is not.
    if (s.messaging_group_id === null) return isTaskThread(s.thread_id);
    // Room sources additionally reach the group's DM sessions (never other
    // rooms — not even same-mg room threads; room→room is not in v1).
    if (sourceSurface === 'room') return isDmMessagingGroup(s.messaging_group_id);
    // DM sources additionally reach sibling sessions of the SAME messaging
    // group — the parallel conversation-threads of that same DM (identical
    // audience). Never rooms, never other DMs' sessions.
    return sourceMessagingGroupId !== null && s.messaging_group_id === sourceMessagingGroupId;
  });
}

function parseContent(raw: string): { text: string; sender: string | null; senderId: string | null } {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      sender: typeof parsed.sender === 'string' ? parsed.sender : null,
      senderId: typeof parsed.senderId === 'string' ? parsed.senderId : null,
    };
  } catch {
    return { text: raw, sender: null, senderId: null };
  }
}

interface EchoFanInput {
  agentGroupId: string;
  sourceSessionId: string;
  /** Messaging group of the source conversation (same-mg sibling detection). */
  sourceMessagingGroupId: string | null;
  origMessageId: string;
  timestamp: string;
  surface: EchoSurface;
  label: string;
  /** Label used when the target is a sibling thread of the same messaging group. */
  siblingLabel: string;
  platformId: string;
  text: string;
  sender: string;
  senderId: string | null;
}

function fanEcho(input: EchoFanInput): number {
  const candidates = getSessionsByAgentGroup(input.agentGroupId);
  const dmCache = new Map<string, boolean>();
  const isDm = (mgId: string): boolean => {
    let v = dmCache.get(mgId);
    if (v === undefined) {
      v = getMessagingGroup(mgId)?.is_group === 0;
      dmCache.set(mgId, v);
    }
    return v;
  };
  const targets = selectEchoTargets(
    candidates,
    input.sourceSessionId,
    input.surface,
    input.sourceMessagingGroupId,
    isDm,
  );
  if (targets.length === 0) return 0;

  const body = {
    text: truncateEchoText(input.text),
    sender: input.sender,
    senderId: input.senderId,
  };
  const content = JSON.stringify({ ...body, echo: { surface: input.surface, label: input.label } });
  // Same-mg sibling threads get a sibling-flavored echo (contract fields
  // identical — only the surface/label values differ).
  const siblingContent = JSON.stringify({
    ...body,
    echo: { surface: ECHO_SIBLING_SURFACE, label: input.siblingLabel },
  });

  let written = 0;
  for (const target of targets) {
    const isSibling =
      input.sourceMessagingGroupId !== null && target.messaging_group_id === input.sourceMessagingGroupId;
    try {
      writeSessionMessage(input.agentGroupId, target.id, {
        id: echoRowId(input.origMessageId, target.id),
        kind: 'chat',
        timestamp: input.timestamp,
        platformId: input.platformId,
        channelType: ECHO_CHANNEL_TYPE,
        threadId: null,
        content: isSibling ? siblingContent : content,
        trigger: 0,
        sourceSessionId: input.sourceSessionId,
      });
      written++;
    } catch (err) {
      // Per-target isolation: one broken session DB (or a duplicate id from a
      // replay) must not stop the rest of the fan — or, upstream, routing.
      log.warn('Echo fan write failed', {
        targetSessionId: target.id,
        origMessageId: input.origMessageId,
        err,
      });
    }
  }
  return written;
}

/**
 * Router hook: fan a just-written trigger=1 inbound message into sibling
 * sessions. Call ONLY for the engaged (wake) branch — accumulate (trigger=0)
 * writes must never fan. Never throws; returns rows written.
 */
export function fanInboundMessage(args: {
  /** Source session the trigger=1 row was written to. */
  session: Session;
  /** Messaging group the message arrived on (the source surface). */
  mg: MessagingGroup;
  /** The id the source row was written with (post agent-group namespacing). */
  messageId: string;
  kind: string;
  /** channel_type as written on the source row. */
  channelType: string;
  content: string;
  timestamp: string;
}): number {
  try {
    const { session, mg } = args;
    if (!CHAT_KINDS.has(args.kind)) return 0;
    // Only real chat surfaces fan: a2a rows and echo rows never re-fan.
    if (args.channelType === 'agent' || args.channelType === ECHO_CHANNEL_TYPE) return 0;
    // Task sessions are never a SOURCE (their traffic is series-internal).
    if (isTaskThread(session.thread_id)) return 0;
    const parsed = parseContent(args.content);
    if (!parsed.text) return 0;
    const surface: EchoSurface = mg.is_group === 1 ? 'room' : 'dm';
    return fanEcho({
      agentGroupId: session.agent_group_id,
      sourceSessionId: session.id,
      sourceMessagingGroupId: mg.id,
      origMessageId: args.messageId,
      timestamp: args.timestamp,
      surface,
      label: buildEchoLabel(mg, parsed.sender),
      siblingLabel: buildSiblingEchoLabel(mg, parsed.sender),
      platformId: mg.platform_id,
      text: parsed.text,
      sender: parsed.sender ?? 'unknown',
      senderId: parsed.senderId,
    });
  } catch (err) {
    log.warn('Inbound echo fan failed', { sessionId: args.session.id, err });
    return 0;
  }
}

/**
 * Delivery hook: fan the agent's own just-delivered user-facing message into
 * sibling sessions. Caller applies the user-facing predicate (kind not
 * system/task_log, channel_type not 'agent'); the guards here are
 * belt-and-braces so the contract holds even if call sites drift. The source
 * surface is the conversation the message was DELIVERED to (origin-session-
 * first, then own-destination-first, mirroring delivery.ts's resolution
 * order — needed so sibling-instance rows sharing one channel address
 * resolve to the sender's own row, not an arbitrary sibling's). Never
 * throws.
 */
export function fanOutboundMessage(
  msg: {
    id: string;
    kind: string;
    platform_id: string | null;
    channel_type: string | null;
    content: string;
  },
  session: Session,
  agentGroup: AgentGroup,
): number {
  try {
    if (msg.kind === 'system' || msg.kind === 'task_log') return 0;
    if (!msg.channel_type || !msg.platform_id) return 0;
    if (msg.channel_type === 'agent' || msg.channel_type === ECHO_CHANNEL_TYPE) return 0;
    // Task sessions are never a SOURCE — their sends already log to the series
    // run log, and fanning them would leak scheduled-run output everywhere.
    if (isTaskThread(session.thread_id)) return 0;

    const originMg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
    const mg =
      originMg && originMg.channel_type === msg.channel_type && originMg.platform_id === msg.platform_id
        ? originMg
        : (getMessagingGroupForOwnDestination(session.agent_group_id, msg.channel_type, msg.platform_id) ??
          getMessagingGroupByPlatform(msg.channel_type, msg.platform_id));
    if (!mg) return 0;

    const parsed = parseContent(msg.content);
    if (!parsed.text) return 0;
    const surface: EchoSurface = mg.is_group === 1 ? 'room' : 'dm';
    return fanEcho({
      agentGroupId: session.agent_group_id,
      sourceSessionId: session.id,
      sourceMessagingGroupId: mg.id,
      origMessageId: msg.id,
      timestamp: new Date().toISOString(),
      surface,
      label: buildEchoLabel(mg, mg.name),
      siblingLabel: buildSiblingEchoLabel(mg, mg.name),
      platformId: mg.platform_id,
      text: parsed.text,
      sender: agentGroup.name,
      senderId: agentGroup.id,
    });
  } catch (err) {
    log.warn('Outbound echo fan failed', { sessionId: session.id, messageId: msg.id, err });
    return 0;
  }
}
