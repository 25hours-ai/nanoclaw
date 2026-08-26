import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const skill = readFileSync('.claude/skills/add-mattermost/SKILL.md', 'utf8');
const localServer = readFileSync('.claude/skills/add-mattermost/LOCAL_SERVER.md', 'utf8');
const compose = readFileSync('.claude/skills/add-mattermost/assets/compose.yml', 'utf8');

describe('Mattermost bot setup guidance', () => {
  it('distinguishes enabling bot creation from creating the bot', () => {
    expect(skill).toContain(
      'System Console → Integrations → Bot Accounts and turn on Enable Bot Account Creation',
    );
    expect(skill).toContain(
      'Product menu → Integrations → Bot Accounts, select Add Bot Account',
    );
    expect(skill).toContain('This setting only permits bot creation; it is not where bots are created.');
  });

  it('requires both team and channel membership', () => {
    expect(skill).toContain('Bots do not join teams or channels automatically.');
  });

  it('configures and verifies the exact canonical SiteURL without weakening origin checks', () => {
    expect(skill).toContain('mmctl config set ServiceSettings.SiteURL "{{base_url}}" --local');
    expect(skill).toContain('/api/v4/config/client?format=old');
    expect(skill).toContain('Do not broaden `ServiceSettings.AllowCorsFrom`');
    expect(skill).toContain('System Console → Environment → Web Server');
    expect(skill).toContain('config_access=docker');
  });

  it('keeps the evaluation server canonical and declarative', () => {
    expect(compose).toContain('MM_SERVICESETTINGS_SITEURL: "http://localhost:8065"');
    expect(compose).not.toContain('MM_SERVICESETTINGS_ALLOWCORSFROM');
    expect(localServer).toContain('`WebsocketURL` stays blank');
    expect(localServer).toContain('/api/v4/config/client?format=old');
  });
});
