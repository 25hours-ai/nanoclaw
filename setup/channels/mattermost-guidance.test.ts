import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const skill = readFileSync('.claude/skills/add-mattermost/SKILL.md', 'utf8');

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
});
