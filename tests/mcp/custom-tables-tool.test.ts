import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomTableAnalyzerFactory } from '../../src/mcp/custom-tables-tool.js';
import { startStdioServer } from '../../src/mcp/stdio.js';
import type {
  CustomTableAnalyzer,
  CustomTableInfo,
} from '../../src/migration/custom-table-analyzer.js';
import {
  ProcessExecutionError,
  type ProcessErrorCode,
} from '../../src/utils/process-runner.js';
import { WpCliOutputError } from '../../src/wordpress/wp-cli-client.js';

const minimalTable: CustomTableInfo = {
  name: 'external_records',
  usesWordPressPrefix: false,
  scope: 'unprefixed',
};

const customTables: CustomTableInfo[] = [
  minimalTable,
  {
    name: 'wp_3_custom_metrics',
    logicalName: 'custom_metrics',
    rowCount: 9210,
    sizeBytes: 3145728,
    engine: 'InnoDB',
    usesWordPressPrefix: true,
    scope: 'site',
    siteSpecific: true,
    siteId: 3,
    referenceHints: [{ column: 'post_id', possibleTarget: 'posts' }],
  },
  {
    name: 'wp_actionscheduler_actions',
    logicalName: 'actionscheduler_actions',
    rowCount: 148220,
    sizeBytes: 48234496,
    dataSizeBytes: 39845888,
    indexSizeBytes: 8388608,
    engine: 'InnoDB',
    collation: 'utf8mb4_unicode_ci',
    usesWordPressPrefix: false,
    likelyOwner: 'Action Scheduler',
    scope: 'network-or-main-site',
    referenceHints: [],
  },
];

describe('migration_list_custom_tables', () => {
  let client: Client;
  let handle: StdioServerHandle;
  const analyze = vi.fn<CustomTableAnalyzer['analyze']>();
  const createAnalyzer = vi.fn<CustomTableAnalyzerFactory>();

  beforeEach(async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    analyze.mockReset().mockResolvedValue(structuredClone(customTables));
    createAnalyzer.mockReset().mockReturnValue({ analyze });
    handle = startStdioServer(
      serverTransport,
      undefined,
      undefined,
      undefined,
      undefined,
      createAnalyzer,
    );
    client = new Client({ name: 'custom-tables-test', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await handle.close();
  });

  it('advertises strict input, typed array output, and read-only annotations', async () => {
    const { tools } = await client.listTools();
    expect(
      tools.find((tool) => tool.name === 'migration_list_custom_tables'),
    ).toMatchObject({
      inputSchema: {
        type: 'object',
        required: ['path'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          customTables: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                usesWordPressPrefix: { type: 'boolean' },
                referenceHints: { type: 'array' },
                rowCount: { type: 'integer' },
                sizeBytes: { type: 'integer' },
                dataSizeBytes: { type: 'integer' },
                indexSizeBytes: { type: 'integer' },
              },
            },
          },
        },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
    expect(createAnalyzer).not.toHaveBeenCalled();
  });

  it('passes the unchanged path and preserves subsite, network/main-site, and unprefixed metadata', async () => {
    const path = '/sites/my wordpress; $(echo literal)';
    const result = await client.callTool({
      name: 'migration_list_custom_tables',
      arguments: { path },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ customTables });
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ]);
    expect(createAnalyzer).toHaveBeenCalledExactlyOnceWith(path);
    expect(analyze).toHaveBeenCalledExactlyOnceWith();
  });

  it('returns a single table with absent optional metadata', async () => {
    analyze.mockResolvedValueOnce([minimalTable]);
    const result = await client.callTool({
      name: 'migration_list_custom_tables',
      arguments: { path: '/site' },
    });
    expect(result.structuredContent).toEqual({
      customTables: [minimalTable],
    });
    expect(result.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({ customTables: [minimalTable] }),
      },
    ]);
  });

  it('preserves zero numeric values, false booleans, and empty reference hints', async () => {
    const table: CustomTableInfo = {
      ...minimalTable,
      rowCount: 0,
      sizeBytes: 0,
      dataSizeBytes: 0,
      indexSizeBytes: 0,
      siteSpecific: false,
      referenceHints: [],
    };
    analyze.mockResolvedValueOnce([table]);
    const result = await client.callTool({
      name: 'migration_list_custom_tables',
      arguments: { path: '/site' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ customTables: [table] });
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ]);
  });

  it('preserves a single-site custom table and unknown scope without reclassification', async () => {
    const tables: CustomTableInfo[] = [
      {
        name: 'wp_99_events',
        logicalName: '99_events',
        usesWordPressPrefix: true,
        scope: 'unknown',
      },
      {
        name: 'wp_events',
        logicalName: 'events',
        usesWordPressPrefix: true,
        scope: 'site',
        siteSpecific: true,
        siteId: 1,
        rowCount: 12,
      },
    ];
    analyze.mockResolvedValueOnce(tables);
    const result = await client.callTool({
      name: 'migration_list_custom_tables',
      arguments: { path: '/site' },
    });
    expect(result.structuredContent).toEqual({ customTables: tables });
  });

  it('strips unexpected credential fields before both output formats', async () => {
    const hint = { column: 'user_id', possibleTarget: 'users' as const };
    const table: CustomTableInfo = {
      ...minimalTable,
      referenceHints: [hint],
    };
    const unexpected = {
      ...table,
      databaseUsername: 'private-user',
      databasePassword: 'private-password',
      DB_USER: 'private-user',
      DB_PASSWORD: 'private-password',
      connection: { password: 'private-secret' },
      referenceHints: [{ ...hint, password: 'private-secret' }],
    };
    analyze.mockResolvedValueOnce([unexpected]);
    const result = await client.callTool({
      name: 'migration_list_custom_tables',
      arguments: { path: '/site' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ customTables: [table] });
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /private|DB_USER|DB_PASSWORD|databaseUsername|databasePassword/,
    );
  });

  it('preserves the analyzer ordering on repeated calls without mutating its results', async () => {
    const entries = structuredClone(customTables);
    analyze.mockResolvedValue(entries);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await client.callTool({
        name: 'migration_list_custom_tables',
        arguments: { path: '/site' },
      });
      expect(result.structuredContent).toEqual({ customTables });
    }
    expect(entries).toEqual(customTables);
  });

  it('returns an empty structured list when the analyzer finds no custom tables', async () => {
    analyze.mockResolvedValueOnce([]);
    const result = await client.callTool({
      name: 'migration_list_custom_tables',
      arguments: { path: '/site' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ customTables: [] });
  });

  it.each([
    {},
    { path: '' },
    { path: '  ' },
    { path: 123 },
    { path: null },
    { path: 'relative/path' },
    { path: '/site\0invalid' },
    { path: '/site', command: 'db query' },
    { path: '/site', sql: 'SELECT 1' },
    { path: '/site', php: 'echo 1;' },
  ])('rejects invalid input %j before creating the analyzer', async (args) => {
    const result = await client.callTool({
      name: 'migration_list_custom_tables',
      arguments: args,
    });
    expect(result.isError).toBe(true);
    expect(createAnalyzer).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
  });

  it.each([
    ['EXECUTABLE_NOT_FOUND', 'PATH'],
    ['TIMEOUT', 'timed out'],
    ['NON_ZERO_EXIT', 'Exit code: 1'],
    ['SPAWN_ERROR', 'permissions'],
    ['SIGNAL_TERMINATION', 'signal'],
    ['OUTPUT_LIMIT', 'capture limit'],
  ] satisfies [ProcessErrorCode, string][])(
    'returns an actionable %s error without exposing raw output',
    async (code, message) => {
      analyze.mockRejectedValueOnce(
        new ProcessExecutionError(
          code,
          {
            stdout: 'private output',
            stderr: 'private stderr',
            exitCode: 1,
            signal: null,
          },
          new Error('private cause'),
        ),
      );
      const result = await client.callTool({
        name: 'migration_list_custom_tables',
        arguments: { path: '/site' },
      });
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: expect.stringContaining(message) }],
      });
      expect(JSON.stringify(result)).toContain(code);
      expect(JSON.stringify(result)).not.toContain('private');
      expect(result.structuredContent).toBeUndefined();
    },
  );

  it.each([
    [
      new WpCliOutputError('eval', new Error('private data')),
      'INVALID_WP_CLI_OUTPUT',
    ],
    [new Error('private data'), 'INTERNAL_ERROR: Custom table information'],
  ])(
    'sanitizes WP-CLI output and unexpected analyzer errors',
    async (error, code) => {
      analyze.mockRejectedValueOnce(error);
      const result = await client.callTool({
        name: 'migration_list_custom_tables',
        arguments: { path: '/site' },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(code);
      expect(JSON.stringify(result)).not.toContain('private');
      expect(result.structuredContent).toBeUndefined();
    },
  );

  it('handles analyzer construction errors safely', async () => {
    createAnalyzer.mockImplementationOnce(() => {
      throw new Error('private data');
    });
    const result = await client.callTool({
      name: 'migration_list_custom_tables',
      arguments: { path: '/site' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('INTERNAL_ERROR');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(analyze).not.toHaveBeenCalled();
  });

  it('rejects invalid analyzer counts instead of returning invalid structured output', async () => {
    analyze.mockResolvedValueOnce([{ ...minimalTable, rowCount: -1 }]);
    const result = await client.callTool({
      name: 'migration_list_custom_tables',
      arguments: { path: '/site' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });
});
