/**
 * Container config types and materialization.
 *
 * Source of truth is the `container_configs` table in the central DB.
 * This module provides:
 *   - Type definitions for the file shape (read by the container runner)
 *   - `materializeContainerJson()` — writes `groups/<folder>/container.json`
 *     from the DB at spawn time
 *   - `configFromDb()` — builds a `ContainerConfig` from a DB row + agent group
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, TIMEZONE } from './config.js';
import { getContainerConfig } from './db/container-configs.js';
import { getAgentGroup } from './db/agent-groups.js';
import { isValidTimezone } from './timezone.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  instructions?: string;
}

export interface McpHttpServerConfig {
  type: 'http';
  url: string;
  instructions?: string;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/** Parse one CLI or approval payload into the persisted MCP config shape. */
export function parseMcpServerConfig(input: Record<string, unknown>): McpServerConfig {
  const command = typeof input.command === 'string' && input.command.trim() ? input.command : undefined;
  const url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : undefined;
  if ((command === undefined) === (url === undefined)) {
    throw new Error('Provide exactly one of --command or --url');
  }

  const instructions = input.instructions;
  if (instructions !== undefined && typeof instructions !== 'string') {
    throw new Error('MCP instructions must be a string');
  }

  if (url) {
    if (input.args !== undefined || input.env !== undefined) {
      throw new Error('--args and --env are only valid with --command');
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      throw new Error('--url must be a valid HTTPS URL', { cause: err });
    }
    if (parsed.protocol !== 'https:') throw new Error('--url must use HTTPS');
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(
        '--url must not contain credentials, query parameters, or fragments; use OneCLI for authentication',
      );
    }
    return { type: 'http', url, ...(instructions === undefined ? {} : { instructions }) };
  }

  const args = input.args ?? [];
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    throw new Error('--args must be a JSON array of strings');
  }
  const rawEnv = input.env ?? {};
  if (typeof rawEnv !== 'object' || rawEnv === null || Array.isArray(rawEnv)) {
    throw new Error('--env must be a JSON object with string values');
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (typeof value !== 'string') throw new Error('--env must be a JSON object with string values');
    env[key] = value;
  }
  if (!command) throw new Error('Provide exactly one of --command or --url');
  return {
    command,
    args,
    env,
    ...(instructions === undefined ? {} : { instructions }),
  };
}

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/** Shape of the materialized `container.json` file read by the container runner. */
export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  skills: string[] | 'all';
  provider?: string;
  groupName?: string;
  assistantName?: string;
  agentGroupId?: string;
  maxMessagesPerPrompt?: number;
  model?: string;
  effort?: string;
  timezone?: string;
}

/**
 * Effective timezone for an agent group: per-group override → install global.
 * The ncl write path validates, but a hand-edited DB value must not silently
 * flip scheduling to UTC — an invalid override falls back to the global tz,
 * same as no override.
 */
export function resolveGroupTimezone(agentGroupId: string): string {
  const tz = getContainerConfig(agentGroupId)?.timezone;
  return tz && isValidTimezone(tz) ? tz : TIMEZONE;
}

/** Build a `ContainerConfig` from a DB row + agent group identity. */
export function configFromDb(row: ContainerConfigRow, group: AgentGroup): ContainerConfig {
  return {
    mcpServers: JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>,
    packages: {
      apt: JSON.parse(row.packages_apt) as string[],
      npm: JSON.parse(row.packages_npm) as string[],
    },
    imageTag: row.image_tag ?? undefined,
    additionalMounts: JSON.parse(row.additional_mounts) as AdditionalMountConfig[],
    skills: JSON.parse(row.skills) as string[] | 'all',
    provider: row.provider ?? undefined,
    groupName: group.name,
    assistantName: row.assistant_name ?? group.name,
    agentGroupId: group.id,
    maxMessagesPerPrompt: row.max_messages_per_prompt ?? undefined,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    timezone: row.timezone && isValidTimezone(row.timezone) ? row.timezone : undefined,
  };
}

/**
 * Materialize `container.json` from the DB. Called at spawn time so the
 * container always sees fresh config. Returns the `ContainerConfig` for
 * use by the caller (buildMounts, buildContainerArgs, etc.).
 */
export function materializeContainerJson(agentGroupId: string): ContainerConfig {
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);

  const row = getContainerConfig(agentGroupId);
  if (!row) throw new Error(`Container config not found for agent group: ${agentGroupId}`);

  const config = configFromDb(row, group);

  const p = path.join(GROUPS_DIR, group.folder, 'container.json');
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');

  return config;
}
