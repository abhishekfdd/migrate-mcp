import { PassThrough } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { expect, it, vi } from 'vitest';
import { startStdioServer } from '../../src/mcp/stdio.js';

it('serves initialization and ping as JSON-RPC over stdio streams', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let received = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    received += chunk;
  });
  const handle = startStdioServer(new StdioServerTransport(input, output));
  const messages = () =>
    received
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

  try {
    input.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'stdio-test', version: '1.0.0' },
        },
      }) + '\n',
    );
    await vi.waitFor(() => {
      expect(messages()).toEqual([
        expect.objectContaining({
          jsonrpc: '2.0',
          id: 1,
          result: expect.objectContaining({
            serverInfo: expect.objectContaining({ name: 'wp-migrate-mcp' }),
          }),
        }),
      ]);
    });

    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'ping', arguments: {} },
      }) + '\n',
    );
    await vi.waitFor(() => {
      expect(messages()).toHaveLength(2);
      expect(messages()[1]).toMatchObject({
        jsonrpc: '2.0',
        id: 2,
        result: {
          structuredContent: { status: 'ok' },
          content: [{ type: 'text', text: '{"status":"ok"}' }],
        },
      });
    });
  } finally {
    await handle.close();
    input.destroy();
    output.destroy();
  }
});
