/**
 * Self-modification MCP tools: install_packages, add_mcp_server.
 *
 * Both are fire-and-forget — the tool writes a system action row and returns
 * immediately. The host processes the request (including admin approval)
 * and notifies the agent via a chat message when complete. Admin approval
 * is approval to apply the change: `install_packages` auto-rebuilds the
 * per-agent image and restarts the container; `add_mcp_server` just
 * updates `container.json` and restarts (bun runs TS directly — no build
 * step needed for a pure MCP wiring change).
 *
 * Package names are sanitized here at the tool boundary AND re-validated on
 * the host side (defense in depth).
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_PACKAGES = 20;

export const installPackages: McpToolDefinition = {
  tool: {
    name: 'install_packages',
    description:
      'Install apt and/or npm packages into YOUR per-agent container image. Requires admin approval; fire-and-forget. On approval, the image is rebuilt and the container is restarted automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        apt: {
          type: 'array',
          items: { type: 'string' },
          description: 'apt packages to install (names only, no version specs or flags)',
        },
        npm: {
          type: 'array',
          items: { type: 'string' },
          description: 'npm packages to install globally (names only, no version specs)',
        },
        reason: { type: 'string', description: 'Why these packages are needed' },
      },
    },
  },
  async handler(args) {
    const apt = (args.apt as string[]) || [];
    const npm = (args.npm as string[]) || [];
    if (apt.length === 0 && npm.length === 0) return err('At least one apt or npm package is required');
    if (apt.length + npm.length > MAX_PACKAGES) return err(`Maximum ${MAX_PACKAGES} packages per request`);

    const invalidApt = apt.find((p) => !APT_RE.test(p));
    if (invalidApt)
      return err(`Invalid apt package name: "${invalidApt}". Only lowercase letters, digits, and ._+- allowed.`);
    const invalidNpm = npm.find((p) => !NPM_RE.test(p));
    if (invalidNpm) return err(`Invalid npm package name: "${invalidNpm}". No version specs or shell characters.`);

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'install_packages',
        apt,
        npm,
        reason: (args.reason as string) || '',
      }),
    });

    log(`install_packages: ${requestId} → apt=[${apt.join(',')}] npm=[${npm.join(',')}]`);
    return ok(`Package install request submitted. You will be notified when admin approves or rejects.`);
  },
};

export const addMcpServer: McpToolDefinition = {
  tool: {
    name: 'add_mcp_server',
    description:
      'Wire an EXISTING third-party MCP server into YOUR per-agent runtime config. Provide either the local `command` + optional `args`/`env`, or its remote HTTPS Streamable HTTP `url`. Requires admin approval; fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'MCP server name (unique identifier)' },
        command: { type: 'string', description: 'Command to run the MCP server' },
        url: { type: 'string', description: 'HTTPS Streamable HTTP MCP endpoint' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments' },
        env: { type: 'object', description: 'Environment variables for the server' },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = typeof args.name === 'string' ? args.name : '';
    const command = typeof args.command === 'string' && args.command.trim() ? args.command : undefined;
    const url = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : undefined;
    if (!name) return err('name is required');
    if ((command === undefined) === (url === undefined)) return err('Provide exactly one of command or url');

    let serverConfig: Record<string, unknown>;
    if (url) {
      if (args.args !== undefined || args.env !== undefined) return err('args and env are only valid with command');
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return err('url must be a valid HTTPS URL');
      }
      if (parsed.protocol !== 'https:') return err('url must use HTTPS');
      if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        return err('url must not contain credentials, query parameters, or fragments; use OneCLI for authentication');
      }
      serverConfig = { type: 'http', url };
    } else if (command) {
      const commandArgs = args.args ?? [];
      if (!Array.isArray(commandArgs) || !commandArgs.every((arg) => typeof arg === 'string')) {
        return err('args must be an array of strings');
      }
      const rawEnv = args.env ?? {};
      if (
        typeof rawEnv !== 'object' ||
        rawEnv === null ||
        Array.isArray(rawEnv) ||
        !Object.values(rawEnv).every((value) => typeof value === 'string')
      ) {
        return err('env must be an object with string values');
      }
      serverConfig = {
        command,
        args: commandArgs,
        env: rawEnv,
      };
    } else {
      return err('Provide exactly one of command or url');
    }

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'add_mcp_server',
        name,
        ...serverConfig,
      }),
    });

    log(`add_mcp_server: ${requestId} → "${name}" (${url ? 'HTTP' : command})`);
    return ok(`MCP server request submitted. You will be notified when admin approves or rejects.`);
  },
};

registerTools([installPackages, addMcpServer]);
