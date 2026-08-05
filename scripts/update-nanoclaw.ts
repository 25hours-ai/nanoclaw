import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  abandonUpdate,
  acknowledgeRequirement,
  cutoverUpdate,
  finishUpdate,
  loadState,
  prepareUpdate,
  resumePreparedUpdate,
  rollbackUpdate,
  summarizeState,
  validateUpdate,
  type UpdateState,
} from './update/transaction.js';

interface ParsedArgs {
  command: string;
  projectRoot: string;
  id?: string;
  upstreamRef?: string;
  strategy?: UpdateState['strategy'];
  commits?: string[];
  requirement?: string;
  status?: 'succeeded' | 'failed';
  rollback?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0];
  if (!command) throw new Error('Missing command');
  const parsed: ParsedArgs = { command, projectRoot: process.cwd() };
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[++i];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag === '--project-root') parsed.projectRoot = path.resolve(value);
    else if (flag === '--id') parsed.id = value;
    else if (flag === '--upstream-ref') parsed.upstreamRef = value;
    else if (flag === '--strategy') {
      if (!['merge', 'rebase', 'cherry-pick'].includes(value)) throw new Error(`Unknown strategy: ${value}`);
      parsed.strategy = value as UpdateState['strategy'];
    } else if (flag === '--commits') parsed.commits = value.split(',').filter(Boolean);
    else if (flag === '--requirement') parsed.requirement = value;
    else if (flag === '--status') {
      if (value !== 'succeeded' && value !== 'failed') throw new Error(`Unknown status: ${value}`);
      parsed.status = value;
    } else if (flag === '--rollback') parsed.rollback = value;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return parsed;
}

function requireValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`Missing ${name}`);
  return value;
}

async function execute(args: ParsedArgs): Promise<UpdateState> {
  if (args.command === 'prepare') {
    return prepareUpdate({
      projectRoot: args.projectRoot,
      upstreamRef: requireValue(args.upstreamRef, '--upstream-ref'),
      strategy: args.strategy,
      commits: args.commits,
    });
  }
  const id = requireValue(args.id, '--id');
  if (args.command === 'resume') return resumePreparedUpdate(args.projectRoot, id);
  if (args.command === 'validate') return validateUpdate(args.projectRoot, id);
  if (args.command === 'cutover') return cutoverUpdate(args.projectRoot, id);
  if (args.command === 'ack') {
    return acknowledgeRequirement(
      args.projectRoot,
      id,
      requireValue(args.requirement, '--requirement'),
      requireValue(args.status, '--status'),
      args.rollback,
    );
  }
  if (args.command === 'finish') return finishUpdate(args.projectRoot, id);
  if (args.command === 'rollback') return rollbackUpdate(args.projectRoot, id);
  if (args.command === 'abandon') return abandonUpdate(args.projectRoot, id);
  if (args.command === 'status') return loadState(args.projectRoot, id);
  throw new Error(`Unknown command: ${args.command}`);
}

async function main(): Promise<void> {
  try {
    const state = await execute(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(summarizeState(state), null, 2)}\n`);
    if (state.phase === 'conflict') process.exitCode = 2;
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify(
        {
          schema: 'nanoclaw-update-error/v1',
          error: err instanceof Error ? err.message : String(err),
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main();
}
