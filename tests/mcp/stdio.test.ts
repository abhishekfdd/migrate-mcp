import { PassThrough } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { expect, it, vi } from 'vitest';
import { startStdioServer } from '../../src/mcp/stdio.js';

it('serves initialization and site info as JSON-RPC over stdio streams', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let received = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    received += chunk;
  });
  const info = {
    wordpressVersion: '6.8.3',
    isMultisite: false,
    siteUrl: 'https://example.test',
    homeUrl: 'https://example.test',
    tablePrefix: 'wp_',
    phpVersion: '8.3.0',
    wpCliVersion: '2.12.0',
  };
  const createService = vi
    .fn()
    .mockReturnValue({ getSiteInfo: vi.fn().mockResolvedValue(info) });
  const handle = startStdioServer(
    new StdioServerTransport(input, output),
    createService,
  );
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
            serverInfo: expect.objectContaining({ name: 'migrate-mcp' }),
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
        params: { name: 'migration_site_info', arguments: { path: '/site' } },
      }) + '\n',
    );
    await vi.waitFor(() => {
      expect(messages()).toHaveLength(2);
      expect(messages()[1]).toMatchObject({
        jsonrpc: '2.0',
        id: 2,
        result: {
          structuredContent: info,
          content: [{ type: 'text', text: JSON.stringify(info) }],
        },
      });
    });
    expect(createService).toHaveBeenCalledExactlyOnceWith('/site');
  } finally {
    await handle.close();
    input.destroy();
    output.destroy();
  }
});
