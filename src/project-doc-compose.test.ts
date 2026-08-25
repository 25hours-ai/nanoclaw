import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-project-doc-compose-test';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  ensureContainerConfig,
  updateContainerConfigScalars,
  updateContainerConfigJson,
} from './db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { PERSONA_PREPEND_FILE } from './group-persona.js';
import { log } from './log.js';
import { composeProjectDoc, type ProjectDocSpec } from './project-doc-compose.js';
import type { AgentGroup } from './types.js';

const CLAUDE_SPEC: ProjectDocSpec = {
  fileName: 'CLAUDE.md',
  baseDocPath: path.join('container', 'CLAUDE.md'),
};

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

function groupDirOf(folder: string): string {
  return path.join(TEST_ROOT, folder);
}

async function seed(id: string, folder: string): Promise<AgentGroup> {
  const ag = group(id, folder);
  await createAgentGroup(ag);
  await ensureContainerConfig(ag.id);
  fs.mkdirSync(groupDirOf(folder), { recursive: true });
  return ag;
}

function writePersona(folder: string, text: string): void {
  fs.writeFileSync(path.join(groupDirOf(folder), PERSONA_PREPEND_FILE), text);
}

async function compose(ag: AgentGroup, spec: ProjectDocSpec = CLAUDE_SPEC): Promise<string> {
  await composeProjectDoc(ag, groupDirOf(ag.folder), spec);
  return fs.readFileSync(path.join(groupDirOf(ag.folder), spec.fileName), 'utf-8');
}

beforeEach(async () => {
  vi.clearAllMocks();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('composeProjectDoc delivery', () => {
  // The regression guard for the bug this composer was rewritten to fix: an
  // `@` import whose target resolves outside the project directory is dropped
  // by Claude Code silently, so the document must not contain one at all.
  it('emits no @ import lines', async () => {
    const ag = await seed('ag-flat', 'flat-group');

    const doc = await compose(ag);

    expect(doc.split('\n').filter((line) => line.startsWith('@'))).toEqual([]);
  });

  it('creates no fragment directory or shared-base symlink', async () => {
    const ag = await seed('ag-artifacts', 'artifacts-group');

    await compose(ag);

    const entries = fs.readdirSync(groupDirOf(ag.folder));
    expect(entries).not.toContain('.claude-fragments');
    expect(entries).not.toContain('.claude-shared.md');
  });

  it('inlines the shared base document, module instructions and resident skill prose', async () => {
    const ag = await seed('ag-inline', 'inline-group');

    const doc = await compose(ag);

    // Prose, not headings, for the two whose absence WAS the bug: a heading
    // proves a section was emitted, only the body proves the file was read.
    expect(doc).toContain('You are a NanoClaw agent.'); // container/CLAUDE.md
    expect(doc).toContain('# Credentials & External Services'); // skills/onecli-gateway/instructions.md
    expect(doc).toContain('# NanoClaw Module: cli');
    expect(doc).toContain('# NanoClaw Module: core');
  });

  it('inlines MCP server instructions from the container config', async () => {
    const ag = await seed('ag-mcp', 'mcp-group');
    await updateContainerConfigJson(ag.id, 'mcp_servers', {
      tooling: { command: 'x', args: [], instructions: 'use the tooling server for builds' },
    });

    const doc = await compose(ag);

    expect(doc).toContain('# MCP Server: tooling');
    expect(doc).toContain('use the tooling server for builds');
  });

  // `.claude/skills/migrate-memory` classifies a staged legacy project doc as
  // generated boilerplate by this prefix. Nothing else guards the composer side.
  it('starts with the composed-at-spawn marker', async () => {
    const ag = await seed('ag-marker', 'marker-group');

    const doc = await compose(ag);

    expect(doc.startsWith('<!-- Composed at spawn')).toBe(true);
    // A heading here instead of a comment would make the header the document's
    // first section and displace the persona.
    expect(doc.split('\n').find((l) => l.startsWith('# '))).not.toBe('# Composed at spawn');
  });

  it('never reads agent-authored files under the group directory except the persona', async () => {
    const ag = await seed('ag-memory', 'memory-group');
    const memoryDir = path.join(groupDirOf(ag.folder), 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'index.md'), 'must not enter the project document');

    const doc = await compose(ag);

    expect(doc).not.toContain('must not enter the project document');
  });
});

describe('composeProjectDoc persona', () => {
  it('leads the document, before the runtime contract', async () => {
    const ag = await seed('ag-persona', 'persona-group');
    writePersona(ag.folder, 'You are an SDR agent.\n');

    const doc = await compose(ag);

    expect(doc.indexOf('# Persona')).toBeGreaterThan(-1);
    expect(doc.indexOf('# Persona')).toBeLessThan(doc.indexOf('# NanoClaw Runtime Contract'));
    expect(doc).toContain('You are an SDR agent.');
  });

  // Compose runs on every spawn, so the second write matters as much as the
  // first: red if writeAtomic stops overwriting an existing document.
  it('overwrites the previous document rather than keeping it', async () => {
    const ag = await seed('ag-persona-2', 'persona-group-2');
    writePersona(ag.folder, 'first persona');
    await compose(ag);

    writePersona(ag.folder, 'second persona');
    const doc = await compose(ag);

    expect(doc).toContain('second persona');
    expect(doc).not.toContain('first persona');
  });

  it('is inert when no persona file is present (non-template groups)', async () => {
    const ag = await seed('ag-no-persona', 'no-persona-group');

    const doc = await compose(ag);

    expect(doc).not.toContain('# Persona');
    expect(doc).toContain('# NanoClaw Runtime Contract');
  });
});

describe('composeProjectDoc skill selection', () => {
  // Red if the walk stops filtering: the document would teach a skill whose
  // SKILL.md syncSkillSymlinks did not plant, which is a live contradiction.
  it('omits resident prose for a skill the group did not select', async () => {
    const ag = await seed('ag-skills-off', 'skills-off-group');
    await updateContainerConfigJson(ag.id, 'skills', ['welcome']);

    const doc = await compose(ag);

    expect(doc).not.toContain('# NanoClaw Skill: onecli-gateway');
    expect(doc).toContain('# NanoClaw Module: core');
  });

  it('inlines every shipping skill at the default selection', async () => {
    const ag = await seed('ag-skills-all', 'skills-all-group');

    const doc = await compose(ag);

    expect(doc).toContain('# NanoClaw Skill: onecli-gateway');
  });
});

describe('composeProjectDoc cli_scope', () => {
  // Red-on-delete guard for the `scheduling`/`cli` exclusion: the agent is
  // taught `ncl tasks` iff it has ncl.
  it('inlines the scheduling module at the default cli_scope', async () => {
    const ag = await seed('ag-sched', 'sched-group');

    const doc = await compose(ag);

    expect(doc).toContain('# NanoClaw Module: scheduling');
    expect(doc).toContain('# NanoClaw Module: cli');
  });

  it('excludes both scheduling and cli when cli_scope is disabled', async () => {
    const ag = await seed('ag-sched-off', 'sched-group-off');
    await updateContainerConfigScalars(ag.id, { cli_scope: 'disabled' });

    const doc = await compose(ag);

    expect(doc).not.toContain('# NanoClaw Module: scheduling');
    expect(doc).not.toContain('# NanoClaw Module: cli');
    expect(doc).toContain('# NanoClaw Module: core');
  });
});

describe('composeProjectDoc spec', () => {
  it('places extra sections after the base document and before the module sections', async () => {
    const ag = await seed('ag-extra', 'extra-group');

    const doc = await compose(ag, {
      ...CLAUDE_SPEC,
      extraSections: [{ name: 'Memory System', body: 'memory pointer body' }],
    });

    expect(doc.indexOf('# NanoClaw Runtime Contract')).toBeLessThan(doc.indexOf('# Memory System'));
    expect(doc.indexOf('# Memory System')).toBeLessThan(doc.indexOf('# NanoClaw Module: agents'));
  });

  it('writes the file named by the spec and tolerates a missing base document', async () => {
    const ag = await seed('ag-nobase', 'nobase-group');

    const doc = await compose(ag, { fileName: 'AGENTS.md', baseDocPath: path.join('container', 'nope.md') });

    expect(doc).not.toContain('# NanoClaw Runtime Contract');
    expect(doc).toContain('# NanoClaw Module: core');
  });
});

describe('composeProjectDoc size cap', () => {
  const bigMcp = (n: number): Record<string, { command: string; args: string[]; instructions: string }> =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`bloated${i}`, { command: 'x', args: [], instructions: 'B'.repeat(9000) }]),
    );

  it('drops the largest droppable sections, keeps the core, and says so in the document', async () => {
    const ag = await seed('ag-cap', 'cap-group');
    writePersona(ag.folder, 'PERSONA_MARKER');
    await updateContainerConfigJson(ag.id, 'mcp_servers', bigMcp(4));

    const doc = await compose(ag, { ...CLAUDE_SPEC, maxBytes: 24 * 1024 });

    expect(Buffer.byteLength(doc, 'utf-8')).toBeLessThanOrEqual(24 * 1024);
    expect(doc).toContain('# Omitted for size');
    expect(doc).toContain('PERSONA_MARKER');
    expect(doc).toContain('# NanoClaw Runtime Contract');
    expect(log.error).toHaveBeenCalled();
  });

  it('applies no cap and logs nothing when maxBytes is unset', async () => {
    const ag = await seed('ag-nocap', 'nocap-group');
    await updateContainerConfigJson(ag.id, 'mcp_servers', bigMcp(4));

    const doc = await compose(ag);

    expect(Buffer.byteLength(doc, 'utf-8')).toBeGreaterThan(32 * 1024);
    expect(doc).not.toContain('# Omitted for size');
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns while there is still headroom, before anything is dropped', async () => {
    const ag = await seed('ag-warn', 'warn-group');
    // Calibrate off whatever the repo's own instruction prose weighs today, so
    // adding a paragraph to a skill cannot break this from another file.
    const bytes = Buffer.byteLength(await compose(ag), 'utf-8');
    vi.clearAllMocks();

    const doc = await compose(ag, { ...CLAUDE_SPEC, maxBytes: Math.ceil(bytes * 1.05) });

    expect(doc).not.toContain('# Omitted for size');
    expect(log.warn).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});
