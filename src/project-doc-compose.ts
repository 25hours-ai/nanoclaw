/**
 * Project-document composition for agent groups.
 *
 * Every provider gets one flat file in `groups/<folder>/`: the group's standing
 * instructions, the provider's shared base document, its own pointer blocks,
 * and one section per capability the group has switched on. Every source is
 * read here, on the host, and written out as text.
 *
 * LOAD-BEARING: nothing may become a pointer again. The previous shape emitted
 * `@` import lines aimed at symlinks under `/app`; Claude Code drops any import
 * resolving outside the project directory, silently, and a headless container
 * has nobody to answer the approval dialog. Eight of nine sections never
 * reached the model. `project-doc-compose.test.ts` ("emits no @ import lines")
 * goes red if that returns.
 *
 * Runs on every container start, so editing a source in the repository still
 * reaches every agent on its next spawn.
 */
import fs from 'fs';
import path from 'path';

import { sanitizeStoredMcpServers } from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { readGroupPersona } from './group-persona.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

/** One `# <name>` block of the composed document. */
interface ProjectDocSection {
  /** Rendered as the heading, and what the size ladder names when it drops one. */
  name: string;
  /** Section body, without the heading. */
  body: string;
  /** Evicted first under `maxBytes`. */
  droppable: boolean;
}

/** Everything that differs between providers. The composition itself does not. */
export interface ProjectDocSpec {
  /** File written into the group directory, e.g. `CLAUDE.md`. */
  fileName: string;
  /** Shared base document, relative to the project root. A missing file is not an error. */
  baseDocPath: string;
  /**
   * Provider-owned blocks, emitted after the base document and before the
   * capability sections. Never droppable, which is why they carry no flag.
   */
  extraSections?: { name: string; body: string }[];
  /** Hard byte cap. Undefined means no cap and no degradation ladder. */
  maxBytes?: number;
}

/** The spec for any provider that has not declared its own agent surfaces. */
export const DEFAULT_PROJECT_DOC: ProjectDocSpec = {
  fileName: 'CLAUDE.md',
  baseDocPath: path.join('container', 'CLAUDE.md'),
};

// LOAD-BEARING: `.claude/skills/migrate-memory` classifies a staged legacy
// project document as generated boilerplate by matching this prefix, so it must
// stay the literal first characters of the file for every provider. Without it
// a migration imports the whole runtime contract into a group's memory tree.
// `project-doc-compose.test.ts` ("starts with the composed-at-spawn marker")
// goes red if it moves.
const COMPOSED_HEADER =
  '<!-- Composed at spawn - do not edit. Standing instructions: instructions.prepend.md. Memory: memory/. -->';

const BASE_DOC_SECTION = 'NanoClaw Runtime Contract';

// Instruction docs that only teach `ncl`, and so are dead weight when the agent
// has none: host dispatch rejects every cli_request at cli_scope=disabled, and
// scheduling teaches `ncl tasks`.
const NCL_DEPENDENT_MODULES = new Set(['cli', 'scheduling']);

// Resolved at call time (process.cwd() = project root) so tests can swap cwd.
const MCP_TOOLS_HOST_SUBPATH = path.join('container', 'agent-runner', 'src', 'mcp-tools');
const SKILLS_HOST_SUBPATH = path.join('container', 'skills');

/**
 * Regenerate `groups/<folder>/<spec.fileName>` from every instruction source
 * the group has switched on. Deterministic: same inputs, same file.
 *
 * Reads nothing the agent can author except `instructions.prepend.md`, which
 * `readGroupPersona` opens with O_NOFOLLOW.
 */
export async function composeProjectDoc(group: AgentGroup, groupDir: string, spec: ProjectDocSpec): Promise<void> {
  if (!fs.existsSync(groupDir)) fs.mkdirSync(groupDir, { recursive: true });

  const configRow = await getContainerConfig(group.id);
  // Re-validated rather than cast: these `instructions` strings are the only
  // stored, agent-influenced text copied verbatim into the system prompt.
  const mcpServers = sanitizeStoredMcpServers(configRow ? JSON.parse(configRow.mcp_servers) : {}, group.name);
  const selectedSkills = configRow ? (JSON.parse(configRow.skills) as string[] | 'all') : 'all';

  const sections: ProjectDocSection[] = [];
  const push = (name: string, body: string, droppable = false): void => {
    const trimmed = body.trim();
    if (trimmed) sections.push({ name, body: trimmed, droppable });
  };

  // The group's standing instructions lead the document, and are never
  // droppable: a group whose persona is evicted stops being that group.
  const persona = readGroupPersona(groupDir);
  if (persona) push('Persona', persona);

  const baseDoc = path.resolve(process.cwd(), spec.baseDocPath);
  if (fs.existsSync(baseDoc)) push(BASE_DOC_SECTION, fs.readFileSync(baseDoc, 'utf-8'));

  for (const extra of spec.extraSections ?? []) push(extra.name, extra.body);

  // Module instructions — every MCP/CLI module shipping a sibling
  // `<name>.instructions.md`, describing how to use that module's tools.
  const cliDisabled = configRow?.cli_scope === 'disabled';
  const mcpToolsHostDir = path.join(process.cwd(), MCP_TOOLS_HOST_SUBPATH);
  if (fs.existsSync(mcpToolsHostDir)) {
    for (const entry of fs.readdirSync(mcpToolsHostDir).sort()) {
      const match = entry.match(/^(.+)\.instructions\.md$/);
      if (!match) continue;
      const moduleName = match[1];
      if (cliDisabled && NCL_DEPENDENT_MODULES.has(moduleName)) continue;
      push(`NanoClaw Module: ${moduleName}`, fs.readFileSync(path.join(mcpToolsHostDir, entry), 'utf-8'), true);
    }
  }

  // Resident skill prose. A skill's `SKILL.md` is loaded on demand by skill
  // discovery; its `instructions.md` is the part that has to be in context
  // before the agent knows it needs it, because a prohibition cannot be lazily
  // loaded. Follows the same selection as the skill links the runner plants, so
  // the document never teaches a skill the agent does not have.
  const skillsHostDir = path.join(process.cwd(), SKILLS_HOST_SUBPATH);
  if (fs.existsSync(skillsHostDir)) {
    for (const skillName of fs.readdirSync(skillsHostDir).sort()) {
      if (selectedSkills !== 'all' && !selectedSkills.includes(skillName)) continue;
      const hostFragment = path.join(skillsHostDir, skillName, 'instructions.md');
      if (!fs.existsSync(hostFragment)) continue;
      push(`NanoClaw Skill: ${skillName}`, fs.readFileSync(hostFragment, 'utf-8'), true);
    }
  }

  // Inline instructions from container.json for user-added external MCP servers.
  for (const [name, mcp] of Object.entries(mcpServers)) {
    if (mcp.instructions) push(`MCP Server: ${name}`, mcp.instructions, true);
  }

  const content =
    spec.maxBytes === undefined ? render(sections) : fitToCap(sections, spec.maxBytes, spec.fileName, group.name);
  writeAtomic(path.join(groupDir, spec.fileName), content);
}

function block(section: ProjectDocSection): string {
  return `# ${section.name}\n\n${section.body}`;
}

function render(sections: ProjectDocSection[]): string {
  return [COMPOSED_HEADER, ...sections.map(block)].join('\n\n') + '\n';
}

/**
 * Fit the document under a provider's project-doc cap by DEGRADING, never
 * throwing: a per-spawn throw rides `wakeContainer`'s transient-retry contract,
 * so host-sweep respawns every 60s forever and the group goes silently dark.
 * Instead drop the largest droppable sections until it fits, log what went at
 * error level, and say so in the document itself. Persona, base document and
 * the provider's own blocks are never droppable.
 */
function fitToCap(sections: ProjectDocSection[], maxBytes: number, fileName: string, groupName: string): string {
  const dropped: string[] = [];
  const renderWithNotice = (): string => {
    const parts = [...sections];
    if (dropped.length > 0) {
      parts.push({
        name: 'Omitted for size',
        body:
          'These instruction sections were omitted to fit the project-document size cap: ' +
          `${dropped.join(', ')}. Their tools still work; consult each tool's own description.`,
        droppable: false,
      });
    }
    return render(parts);
  };

  let content = renderWithNotice();
  while (Buffer.byteLength(content, 'utf-8') > maxBytes) {
    const [largest] = sections
      .filter((s) => s.droppable)
      .sort((a, b) => Buffer.byteLength(block(b), 'utf-8') - Buffer.byteLength(block(a), 'utf-8'));
    if (!largest) break; // Only core left — write oversized rather than brick the group.
    sections.splice(sections.indexOf(largest), 1);
    dropped.push(largest.name);
    content = renderWithNotice();
  }

  const bytes = Buffer.byteLength(content, 'utf-8');
  const sectionBytes = (): { section: string; bytes: number }[] =>
    sections.map((s) => ({ section: s.name, bytes: Buffer.byteLength(block(s), 'utf-8') }));
  if (dropped.length > 0) {
    log.error('Project document exceeded its size cap — dropped the largest instruction sections', {
      file: fileName,
      group: groupName,
      bytes,
      maxBytes,
      dropped,
      sections: sectionBytes(),
    });
    return content;
  }
  // One warning while there is still headroom, so pressure is visible before
  // sections start disappearing.
  const warnBytes = Math.floor(maxBytes - maxBytes / 8);
  if (bytes >= warnBytes) {
    log.warn('Project document is near its size cap', {
      file: fileName,
      group: groupName,
      bytes,
      warnBytes,
      maxBytes,
      sections: sectionBytes(),
    });
  }
  return content;
}

function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, filePath);
  } finally {
    // The group directory is the agent's read-write working directory; a failed
    // rename must not leave a `CLAUDE.md.tmp-<pid>` sitting next to the real one.
    fs.rmSync(tmp, { force: true });
  }
}
