/**
 * One-shot migration: remove the artifacts the old import-based project-doc
 * composer left in each group folder — `.claude-fragments/` (a directory of
 * symlinks into `/app`) and `.claude-shared.md`.
 *
 * They are inert after the flat-inline change, but the read-only mounts that
 * used to cover them are gone, so on an upgraded install they sit in the
 * agent's read-write working directory looking exactly like instruction
 * fragments. Removing one out from under a container adopted at startup is
 * harmless for the same reason: nothing reads them.
 *
 * Introduced in v2.3.x. DELETE THIS FILE AND ITS CALL IN `index.ts` once no
 * supported install can still be upgrading from a pre-flat-inline version.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { log } from './log.js';

const LEGACY_ENTRIES = ['.claude-fragments', '.claude-shared.md'];

/**
 * Sweep every group folder on disk. Enumerates the filesystem rather than the
 * agent_groups table so folders of deleted groups are cleaned too, which is
 * also what lets this run before the central DB is known to be local.
 */
export function cleanupLegacyFragments(): void {
  let removed = 0;
  for (const folder of readDirOrEmpty(GROUPS_DIR)) {
    const dir = path.join(GROUPS_DIR, folder);
    // readdir, not a stat per entry: `.claude-shared.md` points at a container
    // path, so it is dangling on the host and existsSync reports false.
    const present = new Set(readDirOrEmpty(dir));
    for (const entry of LEGACY_ENTRIES) {
      if (!present.has(entry)) continue;
      try {
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
        removed++;
      } catch (err) {
        log.warn('Could not remove legacy project-doc artifact', { path: path.join(dir, entry), err: String(err) });
      }
    }
  }

  if (removed > 0) {
    log.info('Removed legacy project-doc artifacts from group folders', { count: removed });
  }
}

function readDirOrEmpty(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return []; // Missing, or not a directory: nothing here to clean.
  }
}
