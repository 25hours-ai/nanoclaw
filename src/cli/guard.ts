/**
 * CLI guard adapter — the command registry's catalog derivation and
 * structural decision, moved verbatim out of dispatch.ts.
 * Declaration is registration: registry.register() derives one
 * catalog entry per command from the CommandDef itself; no second file is
 * edited when a command is added.
 *
 * The decide fn carries today's decisions exactly:
 *   host caller → allow (the 0600 socket is the auth story — in code,
 *   unremovable by data);
 *   cli_scope 'disabled' → deny; 'group' → resource allowlist, cross-group
 *   arg denial, cli_scope-change denial;
 *   access 'approval' for agent callers → hold for the group's admin chain.
 *
 * Arg auto-fill, the sessions-get existence oracle, and post-handler row
 * filtering stay in dispatch.ts — mechanics, not policy.
 */
import { getContainerConfig } from '../db/container-configs.js';
import { getMessagingGroupAgent } from '../db/messaging-groups.js';
import { ALLOW, DENY, HOLD, type GuardedActionSpec, type GuardInput } from '../guard/index.js';
import { GROUP_SCOPE_RESOURCES, type CommandDef } from './registry.js';

const GROUP_WIRING_COMMANDS = new Set(['wirings-list', 'wirings-get', 'wirings-update', 'wirings-help']);
const GROUP_WIRING_UPDATE_ARGS = new Set(['id', 'agent_group_id', 'group', 'help', 'engage_mode', 'engage_pattern']);
const WIRING_NOT_FOUND = 'Wiring not found in this agent group.';

/** Dotted catalog action name for a command. */
export function commandGuardAction(cmd: Pick<CommandDef, 'name' | 'action'>): string {
  return cmd.action ?? `cli.${cmd.name}`;
}

/** Catalog entry derived from a CommandDef at registration time. */
export function commandGuardSpec(cmd: CommandDef): GuardedActionSpec {
  return {
    action: commandGuardAction(cmd),
    grantActionName: cmd.access === 'approval' ? 'cli_command' : undefined,
    // Bind a cli_command grant to the exact command it was approved for.
    grantCoversRequest: (grant) => {
      try {
        const payload = JSON.parse(grant.payload) as { frame?: { command?: string } };
        return payload.frame?.command === cmd.name;
      } catch {
        return false;
      }
    },
    decide: (input) => commandDecide(cmd, input),
  };
}

function commandDecide(cmd: CommandDef, input: GuardInput) {
  const { actor } = input;
  if (actor.kind === 'host') return ALLOW('host caller (trusted socket)');
  if (actor.kind !== 'agent') return DENY('CLI commands accept host or agent callers only.');

  // Host-only commands (e.g. mount management) are operator-only: rejected for
  // ANY container caller, regardless of cli_scope (even `global`) or approval.
  // The mount allowlist is the boundary cli_scope itself lives inside, so an
  // agent must never alter it — not even with admin approval.
  if (cmd.hostOnly) {
    return DENY(`"${cmd.name}" is operator-only and cannot be run from inside a container.`);
  }

  const args = input.payload;
  const cliScope = getContainerConfig(actor.agentGroupId)?.cli_scope ?? 'group';

  if (cliScope === 'disabled') {
    return DENY('CLI access is disabled for this agent group.');
  }

  if (cliScope === 'group') {
    // Only allow whitelisted resources and general commands (no resource, like help)
    if (cmd.resource && !GROUP_SCOPE_RESOURCES.has(cmd.resource)) {
      return DENY(`CLI access is scoped to this agent group. Cannot access "${cmd.resource}".`);
    }

    // Enforce group scope on all agent-group-related args.
    // Different resources use different arg names for the agent group ID.
    // Only check --id for resources where it IS the agent group ID.
    for (const key of ['agent_group_id', 'agent-group-id', 'group'] as const) {
      if (args[key] && args[key] !== actor.agentGroupId) {
        return DENY('CLI access is scoped to this agent group.');
      }
    }
    if ((cmd.resource === 'groups' || cmd.resource === 'destinations') && args.id && args.id !== actor.agentGroupId) {
      return DENY('CLI access is scoped to this agent group.');
    }

    if (cmd.resource === 'wirings') {
      if (args.agent_group !== undefined || args['agent-group'] !== undefined) {
        return DENY('CLI access is scoped to this agent group.');
      }

      if (!GROUP_WIRING_COMMANDS.has(cmd.name)) {
        return DENY('Group-scoped agents may only list, get, update, or inspect help for wirings.');
      }

      if (args.help !== true && (cmd.name === 'wirings-get' || cmd.name === 'wirings-update')) {
        const id = typeof args.id === 'string' ? args.id : '';
        const wiring = id ? getMessagingGroupAgent(id) : undefined;
        if (!wiring || wiring.agent_group_id !== actor.agentGroupId) {
          return DENY(WIRING_NOT_FOUND);
        }
      }

      if (
        cmd.name === 'wirings-update' &&
        Object.keys(args).some((key) => !GROUP_WIRING_UPDATE_ARGS.has(key.replace(/-/g, '_')))
      ) {
        return DENY('Group-scoped wiring updates may only change engage_mode or engage_pattern.');
      }
    }

    // Block cli_scope changes from group-scoped agents (privilege escalation)
    if (args.cli_scope !== undefined || args['cli-scope'] !== undefined) {
      return DENY('Cannot change cli_scope from a group-scoped agent.');
    }
  }

  if (cmd.access === 'approval') {
    return HOLD(`agent-initiated "${cmd.name}" requires admin approval`);
  }

  return ALLOW('open command');
}
