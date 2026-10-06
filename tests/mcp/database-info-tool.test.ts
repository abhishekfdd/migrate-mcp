import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startStdioServer } from '../../src/mcp/stdio.js';
import type { DatabaseInfoServiceFactory } from '../../src/mcp/database-info-tool.js';
import type { DatabaseInfoService } from '../../src/wordpress/database-info-service.js';
import { WpCliOutputError } from '../../src/wordpress/wp-cli-client.js';
import {
  ProcessExecutionError,
  type ProcessErrorCode,
} from '../../src/utils/process-runner.js';

const databaseInfo = {
  databaseName: 'wordpress',
  databaseHost: 'db',
  tablePrefix: 'wp_',
  tableCount: 18,
  coreTableCount: 12,
  customTableCount: 6,
  sizeBytes: 28499112,
  charset: 'utf8mb4',
  collation: 'utf8mb4_unicode_ci',
  multisite: false,
};

describe('migration_database_info', () => {
  let client: Client;
  let handle: StdioServerHandle;
  const getDatabaseInfo = vi.fn<DatabaseInfoService['getDatabaseInfo']>();
  const createService = vi.fn<DatabaseInfoServiceFactory>();

  beforeEach(async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    getDatabaseInfo.mockReset().mockResolvedValue(databaseInfo);
    createService.mockReset().mockReturnValue({ getDatabaseInfo });
    handle = startStdioServer(serverTransport, undefined, createService);
    client = new Client({ name: 'database-test', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await handle.close();
  });

  it('advertises strict input, numeric output, and read-only annotations', async () => {
    const { tools } = await client.listTools();
    expect(
      tools.find((tool) => tool.name === 'migration_database_info'),
    ).toMatchObject({
      inputSchema: {
        type: 'object',
        required: ['path'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          tableCount: { type: 'integer' },
          sizeBytes: { type: 'integer' },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    });
    expect(createService).not.toHaveBeenCalled();
  });

  it('passes the unchanged path to the service and returns structured numbers', async () => {
    const path = '/sites/my wordpress; $(echo literal)';
    const result = await client.callTool({
      name: 'migration_database_info',
      arguments: { path },
    });
    expect(result).toMatchObject({
      structuredContent: databaseInfo,
      content: [{ type: 'text', text: JSON.stringify(databaseInfo) }],
    });
    expect(result.isError).not.toBe(true);
    expect(createService).toHaveBeenCalledExactlyOnceWith(path);
    expect(getDatabaseInfo).toHaveBeenCalledExactlyOnceWith();
  });

  it('omits absent optional values', async () => {
    const required = {
      databaseName: 'wordpress',
      databaseHost: 'db',
      tablePrefix: 'wp_',
      tableCount: 12,
      coreTableCount: 12,
      customTableCount: 0,
      multisite: false,
    };
    getDatabaseInfo.mockResolvedValueOnce(required);
    const result = await client.callTool({
      name: 'migration_database_info',
      arguments: { path: '/site' },
    });
    expect(result.structuredContent).toEqual(required);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(required) },
    ]);
  });

  it('preserves multisite siteCount and zero optional numeric values', async () => {
    const info = {
      ...databaseInfo,
      multisite: true,
      siteCount: 3,
      sizeBytes: 0,
    };
    getDatabaseInfo.mockResolvedValueOnce(info);
    const result = await client.callTool({
      name: 'migration_database_info',
      arguments: { path: '/site' },
    });
    expect(result.structuredContent).toEqual(info);
  });

  it('strips unexpected credentials and connection fields before both output formats', async () => {
    const unexpected = {
      ...databaseInfo,
      databaseUsername: 'private-user',
      databasePassword: 'private-password',
      DB_USER: 'private-user',
      DB_PASSWORD: 'private-password',
      AUTH_SALT: 'private-salt',
      connection: { password: 'private-secret' },
    };
    getDatabaseInfo.mockResolvedValueOnce(unexpected);
    const result = await client.callTool({
      name: 'migration_database_info',
      arguments: { path: '/site' },
    });
    expect(result.structuredContent).toEqual(databaseInfo);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(databaseInfo) },
    ]);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it.each([
    {},
    { path: '' },
    { path: '  ' },
    { path: 123 },
    { path: null },
    { path: 'relative/path' },
    { path: '/site\0invalid' },
    { path: '/site', query: 'SELECT 1' },
  ])(
    'rejects invalid arguments %j without invoking the service',
    async (args) => {
      const result = await client.callTool({
        name: 'migration_database_info',
        arguments: args,
      });
      expect(result.isError).toBe(true);
      expect(createService).not.toHaveBeenCalled();
      expect(getDatabaseInfo).not.toHaveBeenCalled();
    },
  );

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
      getDatabaseInfo.mockRejectedValueOnce(
        new ProcessExecutionError(
          code,
          {
            stdout: 'DB_USER=private-user',
            stderr: 'DB_PASSWORD=private-secret',
            exitCode: 1,
            signal: null,
          },
          new Error('AUTH_SALT=private-salt'),
        ),
      );
      const result = await client.callTool({
        name: 'migration_database_info',
        arguments: { path: '/site' },
      });
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: expect.stringContaining(message) }],
      });
      expect(JSON.stringify(result)).toContain(code);
      expect(JSON.stringify(result)).not.toMatch(
        /private|DB_USER|DB_PASSWORD|AUTH_SALT/,
      );
      expect(result.structuredContent).toBeUndefined();
    },
  );

  it.each([
    [
      new WpCliOutputError('eval', new Error('private-secret')),
      'INVALID_WP_CLI_OUTPUT',
    ],
    [new Error('private-secret'), 'INTERNAL_ERROR: Database information'],
  ])('sanitizes output and unexpected service errors', async (error, code) => {
    getDatabaseInfo.mockRejectedValueOnce(error);
    const result = await client.callTool({
      name: 'migration_database_info',
      arguments: { path: '/site' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(code);
    expect(JSON.stringify(result)).not.toContain('private-secret');
  });

  it('handles service construction failures without leaking exception details', async () => {
    createService.mockImplementationOnce(() => {
      throw new Error('private-secret');
    });
    const result = await client.callTool({
      name: 'migration_database_info',
      arguments: { path: '/site' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-secret');
  });

  it('rejects invalid numeric service output safely', async () => {
    getDatabaseInfo.mockResolvedValueOnce({ ...databaseInfo, tableCount: -1 });
    const result = await client.callTool({
      name: 'migration_database_info',
      arguments: { path: '/site' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });
});
