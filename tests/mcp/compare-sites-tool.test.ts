import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteComparisonServiceFactory } from '../../src/mcp/compare-sites-tool.js';
import { startStdioServer } from '../../src/mcp/stdio.js';
import type {
  SiteComparisonService,
  SiteComparison,
} from '../../src/migration/site-comparison.js';
import {
  ProcessExecutionError,
  type ProcessErrorCode,
} from '../../src/utils/process-runner.js';
import { WpCliOutputError } from '../../src/wordpress/wp-cli-client.js';
import {
  comparisonWithRisks,
  identicalComparison,
} from '../fixtures/site-comparison-result.js';

describe('migration_compare_sites', () => {
  let client: Client;
  let handle: StdioServerHandle;
  const compare = vi.fn<SiteComparisonService['compare']>();
  const createService = vi.fn<SiteComparisonServiceFactory>();
  const input = { sourcePath: '/source', targetPath: '/target' };
  const call = (args: Record<string, unknown> = input) =>
    client.callTool({ name: 'migration_compare_sites', arguments: args });

  beforeEach(async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    compare.mockReset().mockResolvedValue(comparisonWithRisks());
    createService.mockReset().mockReturnValue({ compare });
    handle = startStdioServer(
      serverTransport,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createService,
    );
    client = new Client({ name: 'comparison-test', version: '1.0.0' });
    await client.connect(clientTransport);
  });
  afterEach(async () => {
    await client.close();
    await handle.close();
  });

  it('advertises strict two-path input, structured output and read-only annotations', async () => {
    const { tools } = await client.listTools();
    expect(
      tools.find(({ name }) => name === 'migration_compare_sites'),
    ).toMatchObject({
      inputSchema: {
        type: 'object',
        required: ['sourcePath', 'targetPath'],
        additionalProperties: false,
        properties: {
          sourcePath: { type: 'string', minLength: 1 },
          targetPath: { type: 'string', minLength: 1 },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          conflicts: { type: 'array' },
          warnings: { type: 'array' },
          summary: {
            type: 'object',
            properties: { conflictCount: { type: 'integer' } },
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
    expect(createService).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();
  });

  it('passes both paths unchanged and returns the complete domain response', async () => {
    const args = {
      sourcePath: '/sites/my source; $(literal)',
      targetPath: '/sites/my target/./',
    };
    const result = await call(args);
    expect(createService).toHaveBeenCalledExactlyOnceWith();
    expect(compare).toHaveBeenCalledExactlyOnceWith(args);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(comparisonWithRisks());
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ]);
  });

  it('preserves identical metadata from distinct installations without introducing conflicts', async () => {
    compare.mockResolvedValueOnce(identicalComparison());
    const result = await call();
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(identicalComparison());
    expect(result.structuredContent).toMatchObject({
      conflicts: [],
      warnings: [],
      summary: { conflictCount: 0, warningCount: 0, blockingConflictCount: 0 },
    });
  });

  it('preserves configuration differences, source/target-only objects, severities and counts', async () => {
    const result = (await call()).structuredContent as SiteComparison;
    expect(result.contentTypes.sourceOnly).toEqual(['movie']);
    expect(result.contentTypes.targetOnly).toEqual(['portfolio']);
    expect(result.contentTypes.changed[0]?.differences.supports).toEqual({
      status: 'different',
      source: ['editor', 'title'],
      target: ['title'],
    });
    expect(result.taxonomies.sourceOnly).toEqual(['genre']);
    expect(result.customTables.shared[0]?.source.rowCount).toBe(42);
    expect(
      result.conflicts.map(({ code, severity }) => [code, severity]),
    ).toEqual([
      ['MULTISITE_MODE_MISMATCH', 'blocking'],
      ['USER_ID_RANGE_OVERLAP', 'high'],
    ]);
    expect(result.warnings.map(({ severity }) => severity)).toEqual([
      'warning',
      'warning',
      'info',
    ]);
    expect(result.summary).toEqual({
      conflictCount: 2,
      warningCount: 3,
      blockingConflictCount: 1,
    });
    expect(result.users.memberships.target).toMatchObject({
      siteCount: 2,
      minUserCount: 0,
    });
  });

  it('keeps unknown values and optional details absent', async () => {
    const result = (await call()).structuredContent as SiteComparison;
    expect(result.media.metrics.missingLocalFiles).toEqual({
      status: 'unknown',
    });
    expect(
      result.contentTypes.unavailable[0]?.fields.restBase,
    ).not.toHaveProperty('source');
    expect(result.customTables.sourceOnly[0]).not.toHaveProperty('sizeBytes');
    expect(result.warnings[2]).not.toHaveProperty('details');
    expect(result.warnings[1]?.details).not.toHaveProperty('count');
  });

  it('preserves service ordering and does not mutate or recompute its response', async () => {
    const info = comparisonWithRisks();
    const before = structuredClone(info);
    compare.mockResolvedValue(info);
    const first = await call();
    const second = await call();
    expect(first).toEqual(second);
    expect(info).toEqual(before);
    expect((first.structuredContent as SiteComparison).conflicts).toEqual(
      info.conflicts,
    );
    expect(
      (first.structuredContent as SiteComparison).contentTypes.volumes,
    ).toEqual(info.contentTypes.volumes);
  });

  it.each([
    {},
    { targetPath: '/target' },
    { sourcePath: '/source' },
    ...['sourcePath', 'targetPath'].flatMap((key) =>
      ['', ' ', 123, null, false, [], {}, 'relative/path', '/bad\0path'].map(
        (value) => ({ ...input, [key]: value }),
      ),
    ),
    { ...input, path: '/other' },
    { ...input, sql: 'SELECT 1' },
    { ...input, command: 'db query' },
    { ...input, execute: true },
  ])('rejects invalid input %j before invoking the service', async (args) => {
    expect((await call(args)).isError).toBe(true);
    expect(createService).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();
  });

  it.each([
    '/source',
    '/source/',
    '/source/.',
    '/source/../source',
    '//source//',
  ])(
    'rejects the same normalized source/target path %s',
    async (targetPath) => {
      const result = await call({ ...input, targetPath });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('SAME_INSTALLATION');
      expect(result.structuredContent).toBeUndefined();
      expect(createService).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['EXECUTABLE_NOT_FOUND', 'PATH'],
    ['TIMEOUT', 'timed out'],
    ['NON_ZERO_EXIT', 'database connectivity'],
    ['SPAWN_ERROR', 'permissions'],
    ['SIGNAL_TERMINATION', 'signal'],
    ['OUTPUT_LIMIT', 'capture limit'],
  ] satisfies [ProcessErrorCode, string][])(
    'sanitizes %s with actionable guidance',
    async (code, guidance) => {
      compare.mockRejectedValueOnce(
        new ProcessExecutionError(
          code,
          {
            stdout: 'private raw content',
            stderr: 'mysql://root:private-password@db SELECT private',
            exitCode: 1,
            signal: null,
          },
          new Error('private cause'),
        ),
      );
      const result = await call();
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.stringify(result)).toContain(code);
      expect(JSON.stringify(result)).toContain(guidance);
      expect(JSON.stringify(result)).not.toContain('private');
    },
  );

  it.each(['source', 'target'])(
    'preserves whole-comparison failure when the %s analyzer fails',
    async (side) => {
      compare.mockRejectedValueOnce(
        new WpCliOutputError(
          'eval',
          new Error(`${side}: private content and credentials`),
        ),
      );
      const result = await call();
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.stringify(result)).toContain('INVALID_WP_CLI_OUTPUT');
      expect(JSON.stringify(result)).not.toContain('private');
      expect(compare).toHaveBeenCalledTimes(1);
    },
  );

  it('sanitizes unexpected comparison failures and service construction errors', async () => {
    compare.mockRejectedValueOnce(
      new Error('Unsupported condition: private credentials'),
    );
    const result = await call();
    expect(JSON.stringify(result)).toContain('INTERNAL_ERROR');
    expect(JSON.stringify(result)).not.toContain('private');
    createService.mockImplementationOnce(() => {
      throw new Error('private constructor failure');
    });
    const construction = await call();
    expect(construction.isError).toBe(true);
    expect(JSON.stringify(construction)).not.toContain('private');
  });

  it('projects extra raw fields out of nested domain objects and finding details', async () => {
    const info = comparisonWithRisks();
    const extras = {
      password: 'private',
      rows: ['private raw content'],
      sql: 'private SQL',
      stack: 'private trace',
    };
    Object.assign(info, extras);
    Object.assign(info.source, extras);
    Object.assign(info.database, extras);
    Object.assign(info.contentTypes.changed[0]!, extras);
    Object.assign(info.contentTypes.changed[0]!.differences.supports!, extras);
    Object.assign(info.customTables.shared[0]!.source, extras);
    Object.assign(info.users.memberships.target, extras);
    Object.assign(info.media.metrics.totalAttachments, extras);
    Object.assign(info.urlReferences.targetHostsInSource[0]!, extras);
    Object.assign(info.conflicts[0]!, extras);
    Object.assign(info.conflicts[0]!.details!, extras);
    Object.assign(info.summary, extras);
    compare.mockResolvedValueOnce(info);
    const result = await call();
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(comparisonWithRisks());
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it.each([
    {
      summary: {
        conflictCount: 'private',
        warningCount: 0,
        blockingConflictCount: 0,
      },
    },
    { users: null },
    {
      conflicts: [
        {
          code: 'TEST',
          severity: 'private',
          category: 'user',
          message: 'private',
        },
      ],
    },
    { media: { metrics: { totalAttachments: 'private' } } },
  ])(
    'rejects malformed comparison results without leaking validation data',
    async (invalid) => {
      compare.mockResolvedValueOnce({
        ...identicalComparison(),
        ...invalid,
      } as unknown as SiteComparison);
      const result = await call();
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.stringify(result)).toContain('INVALID_COMPARISON_RESPONSE');
      expect(JSON.stringify(result)).not.toContain('private');
    },
  );
});
