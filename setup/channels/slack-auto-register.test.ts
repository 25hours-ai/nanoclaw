/**
 * The NANOCLAW_SLACK_AGENTS opt-out gate.
 *
 * The managed Slack experience registers by default: pre-step for slack,
 * companion skills declared in prerequisite order, flow lazy-loaded only
 * when the wizard actually invokes it. Setting the flag to "0" must leave
 * the wizard exactly as a build without the feature: no pre-step, no
 * companions, the provisioning flow never evaluated.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerSlackAutoProvision, SLACK_AGENTS_COMPANION_SKILLS } from './slack-auto-register.js';

afterEach(() => {
  delete process.env.NANOCLAW_SLACK_AGENTS;
  vi.doUnmock('./slack-auto.js');
  vi.resetModules();
});

describe('registerSlackAutoProvision', () => {
  it('flag unset (the default): registers a slack pre-step that lazy-loads and delegates to the flow', async () => {
    const register = vi.fn();
    registerSlackAutoProvision(register, vi.fn(), {});

    expect(register).toHaveBeenCalledTimes(1);
    const [channel, step] = register.mock.calls[0];
    expect(channel).toBe('slack');

    // The flow module is only reached through the pre-step's dynamic import.
    const maybeAutoProvisionSlack = vi.fn(async (name: string) => ({ bot_token: `xoxb-for-${name}` }));
    vi.doMock('./slack-auto.js', () => ({ maybeAutoProvisionSlack }));
    await expect(step('Nano')).resolves.toEqual({ bot_token: 'xoxb-for-Nano' });
    expect(maybeAutoProvisionSlack).toHaveBeenCalledExactlyOnceWith('Nano');
  });

  it('flag unset (the default): declares the agents companion skills in prerequisite order', () => {
    const registerCompanions = vi.fn();
    registerSlackAutoProvision(vi.fn(), registerCompanions, {});

    expect(registerCompanions).toHaveBeenCalledExactlyOnceWith('slack', SLACK_AGENTS_COMPANION_SKILLS);
    // The room admission policy is the flow's prerequisite — order is the API.
    expect(SLACK_AGENTS_COMPANION_SKILLS).toEqual(['slack-a2a-rooms', 'slack-agent-flow']);
  });

  it('only "0" opts out — registers nothing at all', () => {
    const register = vi.fn();
    const registerCompanions = vi.fn();
    registerSlackAutoProvision(register, registerCompanions, { NANOCLAW_SLACK_AGENTS: '0' });
    expect(register).not.toHaveBeenCalled();
    expect(registerCompanions).not.toHaveBeenCalled();
  });

  it('"1" and other values keep the default-on behavior', () => {
    const register = vi.fn();
    const registerCompanions = vi.fn();
    for (const value of ['1', '', 'false', 'yes', 'true']) {
      registerSlackAutoProvision(register, registerCompanions, { NANOCLAW_SLACK_AGENTS: value });
    }
    expect(register).toHaveBeenCalledTimes(5);
    expect(registerCompanions).toHaveBeenCalledTimes(5);
  });
});

describe('companions registry wiring', () => {
  it('flag unset: a fresh companions module carries the slack pre-step and companion list', async () => {
    delete process.env.NANOCLAW_SLACK_AGENTS;
    vi.resetModules();
    const companions = await import('./companions.js');
    expect(companions.getChannelPreStep('slack')).toBeTypeOf('function');
    // Declared at wizard boot — a registration appended to the registry file
    // mid-run would be invisible to the already-imported module, so the whole
    // agents install rides on this boot-time declaration.
    expect(companions.getCompanionSkills('slack')).toEqual(['slack-a2a-rooms', 'slack-agent-flow']);
  });

  it('flag "0": a fresh companions module has no slack hooks at all', async () => {
    process.env.NANOCLAW_SLACK_AGENTS = '0';
    vi.resetModules();
    const companions = await import('./companions.js');
    expect(companions.getChannelPreStep('slack')).toBeUndefined();
    expect(companions.getCompanionSkills('slack')).toEqual([]);
  });
});
