import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startStdioServer } from '../../src/mcp/stdio.js';
import type { SiteInfoServiceFactory } from '../../src/mcp/site-info-tool.js';
import type { SiteInfoService } from '../../src/wordpress/site-info-service.js';
import { WpCliOutputError } from '../../src/wordpress/wp-cli-client.js';
import {
  ProcessExecutionError,
  type ProcessErrorCode,
} from '../../src/utils/process-runner.js';

const siteInfo = {
  wordpressVersion: '6.8.3',
  isMultisite: false,
  siteUrl: 'https://example.test/wp',
  homeUrl: 'https://example.test',
  tablePrefix: 'wp_',
  phpVersion: '8.3.0',
  wpCliVersion: '2.12.0',
};

describe('MCP server', () => {
  let client: Client;
  let handle: StdioServerHandle;
  const getSiteInfo = vi.fn<SiteInfoService['getSiteInfo']>();
  const createService = vi.fn<SiteInfoServiceFactory>();

  beforeEach(async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    getSiteInfo.mockReset().mockResolvedValue(siteInfo);
    createService.mockReset().mockReturnValue({ getSiteInfo });
    handle = startStdioServer(serverTransport, createService);
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
      name: 'migrate-mcp',
      version,
    });
  });

  it('exposes the analysis, comparison, and planning tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'migration_site_info',
      'migration_database_info',
      'migration_list_content_types',
      'migration_list_taxonomies',
      'migration_list_custom_tables',
      'migration_analyze_users',
      'migration_analyze_media',
      'migration_analyze_urls',
      'migration_compare_sites',
      'migration_generate_plan',
    ]);
    expect(tools[0]).toMatchObject({
      name: 'migration_site_info',
      inputSchema: {
        type: 'object',
        required: ['path'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { isMultisite: { type: 'boolean' } },
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
    expect(createService).not.toHaveBeenCalled();
  });

  it('calls the service with the unchanged path and returns structured site info', async () => {
    const path = '/sites/my wordpress; $(echo literal)';
    const result = await client.callTool({
      name: 'migration_site_info',
      arguments: { path },
    });
    expect(result).toMatchObject({
      structuredContent: siteInfo,
      content: [{ type: 'text', text: JSON.stringify(siteInfo) }],
    });
    expect(result.isError).not.toBe(true);
    expect(createService).toHaveBeenCalledExactlyOnceWith(path);
    expect(getSiteInfo).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([
    {},
    { path: '' },
    { path: '   ' },
    { path: 123 },
    { path: null },
    { path: 'relative/path' },
    { path: '/site\0invalid' },
    { path: '/site', command: 'delete' },
  ])('rejects invalid input %j before calling the service', async (args) => {
    const result = await client.callTool({
      name: 'migration_site_info',
      arguments: args,
    });
    expect(result.isError).toBe(true);
    expect(createService).not.toHaveBeenCalled();
    expect(getSiteInfo).not.toHaveBeenCalled();
  });

  it.each([
    ['EXECUTABLE_NOT_FOUND', 'PATH'],
    ['TIMEOUT', 'timed out'],
    ['NON_ZERO_EXIT', 'Exit code: 1'],
    ['SPAWN_ERROR', 'permissions'],
    ['SIGNAL_TERMINATION', 'signal'],
    ['OUTPUT_LIMIT', 'capture limit'],
  ] satisfies [ProcessErrorCode, string][])(
    'translates %s into an actionable tool error',
    async (code, expected) => {
      getSiteInfo.mockRejectedValueOnce(
        new ProcessExecutionError(
          code,
          {
            stdout: 'private output',
            stderr: 'DB_PASSWORD=secret',
            exitCode: 1,
            signal: null,
          },
          new Error('private exception'),
        ),
      );
      const result = await client.callTool({
        name: 'migration_site_info',
        arguments: { path: '/site' },
      });
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: expect.stringContaining(expected) }],
      });
      expect(JSON.stringify(result)).toContain(code);
      expect(JSON.stringify(result)).not.toMatch(/private|secret|DB_PASSWORD/);
      expect(result.structuredContent).toBeUndefined();
    },
  );

  it.each([
    [
      new WpCliOutputError('eval', new Error('private data')),
      'INVALID_WP_CLI_OUTPUT',
    ],
    [new Error('private data'), 'INTERNAL_ERROR'],
  ])('handles output and unexpected errors safely', async (error, code) => {
    getSiteInfo.mockRejectedValueOnce(error);
    const result = await client.callTool({
      name: 'migration_site_info',
      arguments: { path: '/site' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(code);
    expect(JSON.stringify(result)).not.toContain('private data');
  });
});
