import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { upsertEnvVar } from '../set-env.js';
import { channelDmLabel, initialChannelOptions, runInitialChannel } from './initial-setup.js';

const skill = readFileSync('.claude/skills/add-mattermost/SKILL.md', 'utf8');
const localServer = readFileSync('.claude/skills/add-mattermost/LOCAL_SERVER.md', 'utf8');
const compose = readFileSync('.claude/skills/add-mattermost/assets/compose.yml', 'utf8');

describe('Mattermost bot setup guidance', () => {
  it('distinguishes enabling bot creation from creating the bot', () => {
    expect(skill).toContain(
      'System Console → Integrations → Bot Accounts. Turn on Enable Bot Account Creation',
    );
    expect(skill).toContain(
      'Open Product menu → Integrations → Bot Accounts. Select Add Bot Account',
    );
    expect(skill).toContain('This setting permits bot creation. You do not create the bot on this page.');
  });

  it('requires both team and channel membership', () => {
    expect(skill).toContain('Mattermost does not add bots to teams or channels automatically.');
  });

  it('offers and dispatches Mattermost as a first-class initial setup option', async () => {
    expect(initialChannelOptions()).toContainEqual({
      value: 'mattermost',
      label: 'Yes, connect Mattermost',
      hint: 'use your server or create an evaluation server',
    });
    const calls: unknown[][] = [];
    await runInitialChannel('mattermost', 'Ethan', async (...args) => {
      calls.push(args);
    });
    expect(calls).toEqual([['mattermost', 'Ethan', { offerBack: true }]]);
    expect(channelDmLabel('mattermost')).toBe('Mattermost DMs');
  });

  it('installs and runs focused adapter regressions with the registration test', () => {
    expect(skill).toContain('src/channels/mattermost-adapter/adapter.test.ts');
    expect(skill).toContain('src/channels/mattermost-adapter/websocket.test.ts');
    expect(skill).toContain(
      'pnpm exec vitest run src/channels/mattermost-registration.test.ts src/channels/mattermost-adapter/adapter.test.ts src/channels/mattermost-adapter/websocket.test.ts',
    );
  });

  it('requires the operator to choose how a detected server is used', () => {
    expect(skill).toContain('The user must select the server');
    expect(skill).toContain('validate:^(use|enter|create)$');
    expect(skill).toContain('Enter `enter` to specify a different Mattermost URL');
    expect(skill).toContain('Enter `create` to create a local evaluation server');
    expect(skill).toContain('Do not select a');
    expect(skill).toContain('server automatically');
    expect(skill).toContain('Enter `install` to create and start these local resources');
    expect(skill).toContain('Port 8065 must be free');
    expect(skill).toContain('for attempt in $(seq 1 30)');
    expect(skill).toContain('curl -fsS --connect-timeout 1 --max-time 1');
    expect(skill).toContain('docker info >/dev/null');
    expect(skill).toContain('logs --tail 100 mattermost');
  });

  it('configures and verifies the exact canonical SiteURL without weakening origin checks', () => {
    expect(skill).toContain('mmctl config set ServiceSettings.SiteURL "{{base_url}}" --local');
    expect(skill).toContain('/api/v4/config/client?format=old');
    expect(skill).toContain('Do not change\n`ServiceSettings.AllowCorsFrom` to correct an Origin error');
    expect(skill).toContain('System Console → Environment → Web Server');
    expect(skill).toContain('config_access=docker');
    expect(skill).toContain(
      'setup/index.ts --step set-env -- --key MATTERMOST_BASE_URL --value "{{base_url}}"',
    );
  });

  it('replaces a stale canonical URL without changing existing credentials', () => {
    const root = mkdtempSync(join(tmpdir(), 'nanoclaw-mattermost-rerun-'));
    const previousCwd = process.cwd();
    const before = [
      'MATTERMOST_BASE_URL=http://localhost:8065',
      'MATTERMOST_BOT_TOKEN=existing-bot-token',
      'MATTERMOST_CALLBACK_URL=http://host.docker.internal:3000/webhook/mattermost',
      'MATTERMOST_CALLBACK_SECRET=existing-callback-secret',
      '',
    ].join('\n');

    try {
      writeFileSync(join(root, '.env'), before);
      process.chdir(root);
      expect(upsertEnvVar('MATTERMOST_BASE_URL', 'http://127.0.0.1:8065')).toEqual({ existed: true });
      expect(readFileSync(join(root, '.env'), 'utf8')).toBe(
        before.replace('http://localhost:8065', 'http://127.0.0.1:8065'),
      );
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the evaluation server canonical and declarative', () => {
    expect(compose).toContain('MM_SERVICESETTINGS_SITEURL: "http://localhost:8065"');
    expect(compose).not.toContain('MM_SERVICESETTINGS_ALLOWCORSFROM');
    expect(localServer).toContain('Keep `WebsocketURL` blank');
    expect(localServer).toContain('/api/v4/config/client?format=old');
  });
});
