import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-cleanup-legacy-fragments-test';

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-cleanup-legacy-fragments-test/groups',
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { cleanupLegacyFragments } from './cleanup-legacy-fragments.js';

const GROUPS_DIR = path.join(TEST_ROOT, 'groups');

/** Recreate what the import-era composer left in a group folder. */
function seedLegacyDebris(folder: string): string {
  const dir = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(path.join(dir, '.claude-fragments'), { recursive: true });
  fs.symlinkSync('/app/src/mcp-tools/cli.instructions.md', path.join(dir, '.claude-fragments', 'module-cli.md'));
  fs.writeFileSync(path.join(dir, '.claude-fragments', 'persona.md'), 'stale persona copy');
  fs.symlinkSync('/app/CLAUDE.md', path.join(dir, '.claude-shared.md'));
  return dir;
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(GROUPS_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('cleanupLegacyFragments', () => {
  it('removes the legacy artifacts and nothing else', () => {
    const dir = seedLegacyDebris('mixed-group');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '<!-- Composed at spawn -->\n');
    fs.writeFileSync(path.join(dir, 'instructions.prepend.md'), 'standing instructions\n');
    fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });

    cleanupLegacyFragments();

    expect(fs.readdirSync(dir).sort()).toEqual(['CLAUDE.md', 'instructions.prepend.md', 'memory']);
  });

  it('is idempotent and a no-op on a clean install', () => {
    seedLegacyDebris('twice-group');

    cleanupLegacyFragments();
    expect(() => cleanupLegacyFragments()).not.toThrow();
  });

  it('does not throw when the groups directory does not exist', () => {
    fs.rmSync(GROUPS_DIR, { recursive: true, force: true });

    expect(() => cleanupLegacyFragments()).not.toThrow();
  });
});
