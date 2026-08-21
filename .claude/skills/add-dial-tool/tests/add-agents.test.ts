import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Runs the real add.sh against stub `onecli` / `ncl` / `docker` / `npm` binaries in
 * a throwaway project root, and asserts which agents end up allowed or blocked.
 * The stubs log every invocation to CALLS so the test reads the exact OneCLI
 * commands the script issued.
 */

const SKILL_DIR = path.resolve(__dirname, '..');
let root: string;
let bin: string;
let calls: string;

const GROUPS = [
  { id: 'ag-sales', name: 'Sales' },
  { id: 'ag-support', name: 'Support' },
];
// OneCLI knows Sales already (selective mode, Anthropic assigned); Support has
// no OneCLI agent yet (never spawned). Tests override per case.
type OcAgent = { id: string; identifier: string; name: string; secretMode: 'all' | 'selective' };
const DEFAULT_AGENTS: OcAgent[] = [
  { id: 'oc-default', identifier: 'default', name: 'Default Agent', secretMode: 'all' },
  { id: 'oc-sales', identifier: 'ag-sales', name: 'Sales', secretMode: 'selective' },
];

function writeStub(name: string, body: string): void {
  const p = path.join(bin, name);
  fs.writeFileSync(p, `#!/usr/bin/env bash\necho "${name} $*" >> "$CALLS"\n${body}\n`, { mode: 0o755 });
}

type Rule = { id: string; agentId: string; name: string; enabled?: boolean; pathPattern?: string | null };
function setup(
  opts: {
    existingRules?: Rule[];
    agents?: OcAgent[];
    /** Secret ids `agents secrets` reports for every agent. */
    assigned?: string[];
    /** Make `onecli agents list` fail. */
    agentsListFails?: boolean;
  } = {},
): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'add-dial-tool-'));
  bin = path.join(root, 'bin');
  calls = path.join(root, 'calls.log');
  fs.mkdirSync(bin);
  fs.writeFileSync(calls, '');
  // Project layout add.sh expects, with the CLI already pinned so no image build runs.
  fs.mkdirSync(path.join(root, 'container', 'skills'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'container', 'cli-tools.json'),
    JSON.stringify([{ name: '@getdial/cli', version: '0.37.0' }]),
  );
  fs.cpSync(SKILL_DIR, path.join(root, '.claude', 'skills', 'add-dial-tool'), { recursive: true });
  // Host auth.json with a key, under an XDG dir inside the sandbox.
  const xdg = path.join(root, 'xdg');
  fs.mkdirSync(path.join(xdg, 'dial'), { recursive: true });
  fs.writeFileSync(path.join(xdg, 'dial', 'auth.v1.json'), JSON.stringify({ apiKey: 'sk_test' }));
  process.env.TEST_XDG = xdg;

  const rules = opts.existingRules ?? [];
  const agents = opts.agents ?? DEFAULT_AGENTS;
  const assigned = opts.assigned ?? ['sec-anthropic'];
  writeStub('dial', 'exit 0');
  writeStub('npm', 'exit 0');
  writeStub('docker', 'exit 0');
  writeStub('ncl', `if [ "$1 $2" = "groups list" ]; then echo '${JSON.stringify({ ok: true, data: GROUPS })}'; fi`);
  writeStub(
    'onecli',
    `
case "$1 $2" in
  "secrets list") echo '{"data":[{"id":"sec-dial","name":"Dial API"}]}' ;;
  "secrets update") echo '{"status":"updated"}' ;;
  "agents list") ${opts.agentsListFails ? 'echo "boom" >&2; exit 1' : `echo '${JSON.stringify({ data: agents })}'`} ;;
  "agents secrets") echo '${JSON.stringify({ data: assigned })}' ;;
  "agents set-secrets") echo '{"status":"updated"}' ;;
  "agents create") echo '{"id":"oc-new","identifier":"ag-support"}' ;;
  "rules list") echo '${JSON.stringify({ data: rules.map((r) => ({ enabled: true, pathPattern: null, method: null, ...r, hostPattern: 'api.getdial.ai', action: 'block' })) })}' ;;
  "rules create") echo '{"id":"rule-new"}' ;;
  "rules update") echo '{"status":"updated"}' ;;
  "rules delete") echo '{"status":"deleted"}' ;;
  *) echo '{}' ;;
esac`,
  );
}

function run(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('bash', [path.join(root, '.claude', 'skills', 'add-dial-tool', 'add.sh'), ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CALLS: calls,
        XDG_DATA_HOME: process.env.TEST_XDG,
        HOME: root,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { stdout: err.stdout ?? '', status: err.status ?? 1 };
  }
}

const callLines = () => fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean);
const field = (out: string, k: string) => (out.match(new RegExp(`^${k}: (.*)$`, 'm')) ?? [])[1];

beforeEach(() => setup());
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('add-dial-tool add.sh --agents', () => {
  it('allows the chosen agent and blocks the rest with an OneCLI rule', () => {
    const { stdout, status } = run(['--agents', 'ag-sales']);
    expect(status).toBe(0);
    expect(field(stdout, 'CREDENTIAL')).toBe('set');
    expect(field(stdout, 'AGENTS_ALLOWED')).toBe('ag-sales');
    expect(field(stdout, 'AGENTS_BLOCKED')).toBe('ag-support');

    const lines = callLines();
    // Sales is selective: keeps its secrets and gains Dial.
    expect(lines).toContain('onecli agents set-secrets --id oc-sales --secret-ids sec-anthropic,sec-dial');
    // Support had no OneCLI agent: created (all mode), secrets NOT touched, blocked by rule.
    expect(lines).toContain('onecli agents create --name Support --identifier ag-support');
    expect(lines.some((l) => l.startsWith('onecli agents set-secrets --id oc-new'))).toBe(false);
    expect(lines).toContain(
      'onecli rules create --name Dial: blocked for Support --host-pattern api.getdial.ai --action block --agent-id oc-new --enabled',
    );
    // The OneCLI default agent is not a NanoClaw group: untouched.
    expect(lines.some((l) => l.includes('oc-default'))).toBe(false);
  });

  it('--agents all opens every group and removes stale block rules', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({ existingRules: [{ id: 'rule-old', agentId: 'oc-sales', name: 'Dial: blocked for Sales' }] });
    const { stdout, status } = run(['--agents', 'all']);
    expect(status).toBe(0);
    expect(field(stdout, 'AGENTS_ALLOWED')).toBe('ag-sales,ag-support');
    expect(field(stdout, 'AGENTS_BLOCKED')).toBe('none');
    const lines = callLines();
    expect(lines).toContain('onecli rules delete --id rule-old');
    expect(lines.some((l) => l.startsWith('onecli rules create'))).toBe(false);
  });

  it('is idempotent: an already-blocked agent gets no second rule', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({ existingRules: [{ id: 'rule-old', agentId: 'oc-sales', name: 'Dial: blocked for Sales' }] });
    const { stdout, status } = run(['--agents', 'ag-support']);
    expect(status).toBe(0);
    expect(field(stdout, 'AGENTS_BLOCKED')).toBe('ag-sales');
    const creates = callLines().filter((l) => l.startsWith('onecli rules create'));
    expect(creates).toHaveLength(0);
  });

  it('refuses an unknown agent id instead of guessing', () => {
    const { stdout, status } = run(['--agents', 'ag-typo']);
    expect(status).toBe(1);
    expect(field(stdout, 'STATUS')).toBe('failed');
    expect(stdout).toContain("unknown agent group 'ag-typo'");
    expect(callLines().some((l) => l.startsWith('onecli rules create'))).toBe(false);
  });

  it('defaults to all when --agents is omitted, so existing callers keep their behaviour', () => {
    const { stdout, status } = run([]);
    expect(status).toBe(0);
    expect(field(stdout, 'AGENTS')).toBe('all');
    expect(field(stdout, 'AGENTS_BLOCKED')).toBe('none');
  });

  it('never calls set-secrets on an all-mode agent (that would switch it to selective and cut other credentials)', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({
      agents: [
        { id: 'oc-default', identifier: 'default', name: 'Default Agent', secretMode: 'all' },
        { id: 'oc-sales', identifier: 'ag-sales', name: 'Sales', secretMode: 'all' },
        { id: 'oc-support', identifier: 'ag-support', name: 'Support', secretMode: 'all' },
      ],
    });
    const { status } = run(['--agents', 'ag-sales']);
    expect(status).toBe(0);
    const lines = callLines();
    expect(lines.some((l) => l.startsWith('onecli agents set-secrets'))).toBe(false);
    // The block rule alone does the scoping for the excluded agent.
    expect(lines.some((l) => l.startsWith('onecli rules create') && l.includes('--agent-id oc-support'))).toBe(true);
  });

  it('blocks a selective agent by rule only, without editing its secret list', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({
      agents: [{ id: 'oc-support', identifier: 'ag-support', name: 'Support', secretMode: 'selective' }],
      assigned: ['sec-dial'],
    });
    const { status, stdout } = run(['--agents', 'ag-sales']);
    expect(status).toBe(0);
    expect(field(stdout, 'AGENTS_BLOCKED')).toBe('ag-support');
    const lines = callLines();
    expect(lines.some((l) => l.startsWith('onecli agents set-secrets --id oc-support'))).toBe(false);
    expect(lines.some((l) => l.startsWith('onecli rules create') && l.includes('--agent-id oc-support'))).toBe(true);
  });

  it('refuses an empty --agents value instead of treating it as all', () => {
    for (const args of [['--agents', ''], ['--agents='], ['--agents', ' , ']]) {
      fs.writeFileSync(calls, '');
      const { status, stdout } = run(args);
      expect(status).toBe(1);
      expect(field(stdout, 'STATUS')).toBe('failed');
      expect(callLines().some((l) => l.startsWith('onecli rules create'))).toBe(false);
    }
  });

  it('--agents none blocks every group', () => {
    const { status, stdout } = run(['--agents', 'none']);
    expect(status).toBe(0);
    expect(field(stdout, 'AGENTS_ALLOWED')).toBe('none');
    expect(field(stdout, 'AGENTS_BLOCKED')).toBe('ag-sales,ag-support');
  });

  it('a disabled block rule does not count as blocking: it is re-enabled', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({
      existingRules: [{ id: 'rule-off', agentId: 'oc-sales', name: 'Dial: blocked for Sales', enabled: false }],
    });
    const { status, stdout } = run(['--agents', 'ag-support']);
    expect(status).toBe(0);
    expect(field(stdout, 'AGENTS_BLOCKED')).toBe('ag-sales');
    expect(callLines()).toContain('onecli rules update --id rule-off --enabled true');
  });

  it("leaves the operator's own path-scoped rule alone when unblocking", () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({ existingRules: [{ id: 'rule-op', agentId: 'oc-sales', name: 'ops: no calls', pathPattern: '/v1/calls' }] });
    const { status } = run(['--agents', 'all']);
    expect(status).toBe(0);
    expect(callLines().some((l) => l.startsWith('onecli rules delete'))).toBe(false);
  });

  it('fails instead of reporting success when OneCLI agents cannot be listed', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({ agentsListFails: true });
    const { status, stdout } = run(['--agents', 'ag-sales']);
    expect(status).toBe(1);
    expect(field(stdout, 'STATUS')).toBe('failed');
  });

  it('tolerates spaces and duplicates in --agents and allows exactly what was named', () => {
    const { status, stdout } = run(['--agents', 'ag-sales, ag-support ,ag-sales']);
    expect(status).toBe(0);
    expect(field(stdout, 'AGENTS_ALLOWED')).toBe('ag-sales,ag-support');
    expect(field(stdout, 'AGENTS_BLOCKED')).toBe('none');
  });
});
