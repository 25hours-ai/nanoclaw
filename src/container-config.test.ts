/**
 * Group-timezone resolution (agent-level timezone feature).
 *
 * The chain is: valid per-group override → install-global TIMEZONE. An
 * invalid stored value (hand-edited DB — the ncl write path validates) must
 * fall back to the global timezone, not silently become UTC, and must never
 * be materialized into container.json.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { TIMEZONE } from './config.js';
import { configFromDb, parseMcpServerConfig, resolveGroupTimezone } from './container-config.js';
import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, initTestDb } from './db/connection.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { runMigrations } from './db/migrations/index.js';
import type { AgentGroup } from './types.js';

const GROUP: AgentGroup = {
  id: 'ag-tz',
  name: 'tz',
  folder: 'tz',
  agent_provider: null,
  created_at: new Date().toISOString(),
};

describe('resolveGroupTimezone', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    createAgentGroup(GROUP);
    ensureContainerConfig(GROUP.id);
  });
  afterEach(() => {
    closeDb();
  });

  it('returns the install-global timezone when no override is set', () => {
    expect(resolveGroupTimezone(GROUP.id)).toBe(TIMEZONE);
    expect(resolveGroupTimezone('ag-no-such-group')).toBe(TIMEZONE);
  });

  it('returns a valid override, and falls back to global on an invalid stored value', () => {
    updateContainerConfigScalars(GROUP.id, { timezone: 'Asia/Tokyo' });
    expect(resolveGroupTimezone(GROUP.id)).toBe('Asia/Tokyo');

    updateContainerConfigScalars(GROUP.id, { timezone: 'Not/AZone' });
    expect(resolveGroupTimezone(GROUP.id)).toBe(TIMEZONE);
  });

  it('configFromDb ships a valid timezone to the container and drops an invalid one', () => {
    updateContainerConfigScalars(GROUP.id, { timezone: 'Asia/Tokyo' });
    expect(configFromDb(getContainerConfig(GROUP.id)!, GROUP).timezone).toBe('Asia/Tokyo');

    updateContainerConfigScalars(GROUP.id, { timezone: 'Not/AZone' });
    expect(configFromDb(getContainerConfig(GROUP.id)!, GROUP).timezone).toBeUndefined();
  });
});

describe('parseMcpServerConfig', () => {
  it('preserves stdio config and accepts HTTPS Streamable HTTP config', () => {
    expect(parseMcpServerConfig({ command: 'pnpm', args: ['dlx', 'server'], env: { TOKEN: 'stub' } })).toEqual({
      command: 'pnpm',
      args: ['dlx', 'server'],
      env: { TOKEN: 'stub' },
    });
    expect(parseMcpServerConfig({ url: 'https://mcp.example.com/mcp' })).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
    });
  });

  it.each([
    [{}, /exactly one/],
    [{ command: 'server', url: 'https://mcp.example.com/mcp' }, /exactly one/],
    [{ url: 'http://mcp.example.com/mcp' }, /HTTPS/],
    [{ url: 'https://token@mcp.example.com/mcp' }, /credentials/],
    [{ url: 'https://mcp.example.com/mcp?api_key=secret' }, /query parameters/],
    [{ url: 'https://mcp.example.com/mcp#secret' }, /fragments/],
    [{ url: 'https://mcp.example.com/mcp', env: {} }, /only valid with --command/],
  ])('rejects invalid transport config %#', (input, message) => {
    expect(() => parseMcpServerConfig(input)).toThrow(message);
  });
});
