import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserAnalyzerFactory } from '../../src/mcp/users-tool.js';
import { startStdioServer } from '../../src/mcp/stdio.js';
import type {
  UserAnalyzer,
  UserAnalysis,
} from '../../src/migration/user-analyzer.js';
import {
  ProcessExecutionError,
  type ProcessErrorCode,
} from '../../src/utils/process-runner.js';
import { WpCliOutputError } from '../../src/wordpress/wp-cli-client.js';

const singleSite: UserAnalysis = {
  totalUsers: 12,
  minUserId: 1,
  maxUserId: 50,
  multisite: false,
  roleSiteId: 1,
  siteUserCount: 12,
  administratorCount: 1,
  roleCounts: { administrator: 1, editor: 2, subscriber: 8 },
  usersWithoutRole: 1,
  duplicateEmailCount: 2,
  duplicateLoginCount: 1,
  usersWithLargeMetaSets: 1,
  warnings: [
    {
      code: 'DUPLICATE_EMAILS',
      message:
        'Users share stored email values; count is extra accounts beyond the first per group.',
      count: 2,
    },
    {
      code: 'DUPLICATE_LOGINS',
      message:
        'Users share stored login values; count is extra accounts beyond the first per group.',
      count: 1,
    },
    {
      code: 'LARGE_USERMETA_SETS',
      message: 'Users have more than 1000 usermeta rows.',
      count: 1,
    },
    {
      code: 'ORPHANED_USERMETA',
      message: 'Usermeta rows reference users absent from the users table.',
      count: 24,
    },
  ],
};

const multisite: UserAnalysis = {
  ...singleSite,
  multisite: true,
  roleSiteId: 2,
  siteUserCount: 4,
  roleCounts: { administrator: 1, editor: 1, subscriber: 1 },
  siteMemberships: [
    { siteId: 1, userCount: 12 },
    { siteId: 2, userCount: 4 },
    { siteId: 3, userCount: 0 },
  ],
};

const empty: UserAnalysis = {
  totalUsers: 0,
  multisite: false,
  roleSiteId: 1,
  siteUserCount: 0,
  administratorCount: 0,
  roleCounts: {},
  usersWithoutRole: 0,
  duplicateEmailCount: 0,
  duplicateLoginCount: 0,
  warnings: [],
};

describe('migration_analyze_users', () => {
  let client: Client;
  let handle: StdioServerHandle;
  const analyze = vi.fn<UserAnalyzer['analyze']>();
  const createAnalyzer = vi.fn<UserAnalyzerFactory>();

  beforeEach(async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    analyze.mockReset().mockResolvedValue(structuredClone(singleSite));
    createAnalyzer.mockReset().mockReturnValue({ analyze });
    handle = startStdioServer(
      serverTransport,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createAnalyzer,
    );
    client = new Client({ name: 'users-test', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await handle.close();
  });

  it('advertises strict input, typed summary output, and read-only annotations', async () => {
    const { tools } = await client.listTools();
    expect(
      tools.find((tool) => tool.name === 'migration_analyze_users'),
    ).toMatchObject({
      inputSchema: {
        type: 'object',
        required: ['path'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          totalUsers: { type: 'integer' },
          maxUserId: { type: 'integer' },
          multisite: { type: 'boolean' },
          roleCounts: { type: 'object' },
          warnings: {
            type: 'array',
            items: {
              type: 'object',
              properties: { count: { type: 'integer' } },
            },
          },
          siteMemberships: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                siteId: { type: 'integer' },
                userCount: { type: 'integer' },
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

  it('passes the unchanged path and returns the full single-site domain summary', async () => {
    const path = '/sites/my wordpress; $(echo literal)';
    const result = await client.callTool({
      name: 'migration_analyze_users',
      arguments: { path },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(singleSite);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ]);
    expect(createAnalyzer).toHaveBeenCalledExactlyOnceWith(path);
    expect(analyze).toHaveBeenCalledExactlyOnceWith();
  });

  it('preserves network totals, active-site roles, and overlapping memberships', async () => {
    analyze.mockResolvedValueOnce(multisite);
    const result = await client.callTool({
      name: 'migration_analyze_users',
      arguments: { path: '/site' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(multisite);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ]);
  });

  it('preserves zeros and empty collections without inventing optional fields', async () => {
    analyze.mockResolvedValueOnce(empty);
    const result = await client.callTool({
      name: 'migration_analyze_users',
      arguments: { path: '/site' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(empty);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ]);
    for (const key of [
      'minUserId',
      'maxUserId',
      'siteMemberships',
      'usersWithLargeMetaSets',
    ]) {
      expect(result.structuredContent).not.toHaveProperty(key);
    }
  });

  it('keeps optional warning counts absent and includes zero optional risk counts', async () => {
    const info: UserAnalysis = {
      ...empty,
      usersWithLargeMetaSets: 0,
      warnings: [
        {
          code: 'USERMETA_RISKS_UNAVAILABLE',
          message:
            'The optional usermeta count analysis was unavailable; orphaned rows and large meta sets may be unassessed.',
        },
      ],
    };
    analyze.mockResolvedValueOnce(info);
    const result = await client.callTool({
      name: 'migration_analyze_users',
      arguments: { path: '/site' },
    });
    expect(result.structuredContent).toEqual(info);
    expect(result.structuredContent).not.toHaveProperty('warnings.0.count');
  });

  it('preserves the analyzer ordering for roles, memberships, and warnings without mutation', async () => {
    const info = structuredClone(multisite);
    analyze.mockResolvedValue(info);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await client.callTool({
        name: 'migration_analyze_users',
        arguments: { path: '/site' },
      });
      expect(result.structuredContent).toEqual(multisite);
      expect(
        Object.keys((result.structuredContent as UserAnalysis).roleCounts),
      ).toEqual(['administrator', 'editor', 'subscriber']);
    }
    expect(info).toEqual(multisite);
  });

  it('strips sensitive extras at the top level and in nested summary objects', async () => {
    const secrets = {
      user_pass: 'private-hash',
      user_activation_key: 'private-key',
      session_tokens: 'private-token',
      application_passwords: 'private-app-password',
      password: 'private-password',
      authSecret: 'private-secret',
      capabilities: 'private-serialized-capabilities',
      duplicateEmails: ['private-email'],
      duplicateUsernames: ['private-login'],
      connection: 'mysql://root:private-password@db',
    };
    const unexpected = {
      ...multisite,
      ...secrets,
      warnings: multisite.warnings.map((warning) => ({
        ...warning,
        ...secrets,
      })),
      siteMemberships:
        multisite.siteMemberships?.map((site) => ({ ...site, ...secrets })) ??
        [],
    };
    analyze.mockResolvedValueOnce(unexpected);
    const result = await client.callTool({
      name: 'migration_analyze_users',
      arguments: { path: '/site' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(multisite);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(result.structuredContent) },
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
    { path: '/site', command: 'db query' },
    { path: '/site', sql: 'SELECT 1' },
    { path: '/site', php: 'echo 1;' },
  ])('rejects invalid input %j before creating the analyzer', async (args) => {
    const result = await client.callTool({
      name: 'migration_analyze_users',
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
            stdout: 'user_pass=private-hash',
            stderr: 'mysql://root:private-password@db',
            exitCode: 1,
            signal: null,
          },
          new Error('private cause'),
        ),
      );
      const result = await client.callTool({
        name: 'migration_analyze_users',
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
    [new Error('private data'), 'INTERNAL_ERROR: User analysis'],
  ])(
    'sanitizes WP-CLI output and unexpected analyzer errors',
    async (error, code) => {
      analyze.mockRejectedValueOnce(error);
      const result = await client.callTool({
        name: 'migration_analyze_users',
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
      name: 'migration_analyze_users',
      arguments: { path: '/site' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('INTERNAL_ERROR');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(analyze).not.toHaveBeenCalled();
  });

  it('rejects invalid analyzer counts instead of returning invalid structured output', async () => {
    analyze.mockResolvedValueOnce({ ...singleSite, totalUsers: -1 });
    const result = await client.callTool({
      name: 'migration_analyze_users',
      arguments: { path: '/site' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('INVALID_ANALYZER_RESPONSE');
    expect(JSON.stringify(result)).toContain('compatibility');
    expect(result.structuredContent).toBeUndefined();
  });

  it.each([
    { totalUsers: '12 private' },
    { maxUserId: Number.MAX_SAFE_INTEGER + 1 },
    { roleCounts: { subscriber: 'private-data' } },
    { siteMemberships: [{ siteId: 'private-id', userCount: 1 }] },
    {
      warnings: [
        { code: 'private-code', message: { password: 'private-secret' } },
      ],
    },
  ])(
    'rejects malformed analyzer fields without echoing their values',
    async (invalid) => {
      // Deliberately violate the service contract to exercise the runtime boundary.
      analyze.mockResolvedValueOnce({
        ...singleSite,
        ...invalid,
      } as unknown as UserAnalysis);
      const result = await client.callTool({
        name: 'migration_analyze_users',
        arguments: { path: '/site' },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.stringify(result)).toContain('INVALID_ANALYZER_RESPONSE');
      expect(JSON.stringify(result)).not.toContain('private');
    },
  );
});
