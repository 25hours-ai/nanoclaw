import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { addMcpServer } from './self-mod.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('add_mcp_server', () => {
  it('submits HTTPS MCP config through the existing approval action', async () => {
    const result = await addMcpServer.handler({ name: 'remote', url: 'https://mcp.example.com/mcp' });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(getUndeliveredMessages()[0].content)).toEqual({
      action: 'add_mcp_server',
      name: 'remote',
      type: 'http',
      url: 'https://mcp.example.com/mcp',
    });
  });

  it('rejects insecure or credential-bearing URLs before requesting approval', async () => {
    for (const url of [
      'http://mcp.example.com/mcp',
      'https://mcp.example.com/mcp?api_key=secret',
      'https://mcp.example.com/mcp#secret',
    ]) {
      const result = await addMcpServer.handler({ name: 'remote', url });
      expect(result.isError).toBe(true);
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
