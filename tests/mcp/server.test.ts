import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startStdioServer } from '../../src/mcp/stdio.js';

describe('MCP server', () => {
  let client: Client;
  let handle: StdioServerHandle;

  beforeEach(async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    handle = startStdioServer(serverTransport);
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await handle.close();
  });

  it('reports the server name and package version', () => {
    const { version } = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(client.getServerVersion()).toMatchObject({
      name: 'wp-migrate-mcp',
      version,
    });
  });

  it('exposes only the internal read-only ping tool', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: 'ping',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: { status: { const: 'ok' } } },
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
  });

  it('returns structured status and a JSON text fallback', async () => {
    const result = await client.callTool({ name: 'ping', arguments: {} });
    expect(result).toMatchObject({
      structuredContent: { status: 'ok' },
      content: [{ type: 'text', text: '{"status":"ok"}' }],
    });
    expect(result.isError).not.toBe(true);
  });
});
