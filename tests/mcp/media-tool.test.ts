import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaAnalyzerFactory } from '../../src/mcp/media-tool.js';
import { startStdioServer } from '../../src/mcp/stdio.js';
import type {
  MediaAnalyzer,
  MediaAnalysis,
} from '../../src/migration/media-analyzer.js';
import {
  ProcessExecutionError,
  type ProcessErrorCode,
} from '../../src/utils/process-runner.js';
import { WpCliOutputError } from '../../src/wordpress/wp-cli-client.js';

const summary: MediaAnalysis = {
  totalAttachments: 12,
  minAttachmentId: 42,
  maxAttachmentId: 600,
  mimeTypeCounts: { 'application/pdf': 2, 'image/jpeg': 8, 'image/png': 2 },
  categoryCounts: { application: 2, image: 10 },
  missingAttachedFileMeta: 1,
  missingAttachmentMetadata: 2,
  unattachedAttachments: 3,
  orphanedAttachments: 1,
  uploadBaseDir: '/custom/media/site-3',
  uploadBaseUrl: 'https://cdn.example.test/media',
  usesYearMonthFolders: true,
  externalMediaCount: 1,
  multisite: false,
  siteId: 1,
  warnings: [
    {
      code: 'EXTERNAL_MEDIA_REFERENCES',
      message:
        'Attachment file metadata contains remote URI indicators; remote availability and offload ownership were not verified.',
      count: 1,
    },
    {
      code: 'LOCAL_FILES_NOT_CHECKED',
      message:
        'Physical file checks were not requested; missingLocalFiles is unavailable.',
    },
    {
      code: 'MISSING_ATTACHED_FILE_META',
      message: 'Attachments lack a non-empty primary _wp_attached_file value.',
      count: 1,
    },
    {
      code: 'MISSING_ATTACHMENT_METADATA',
      message:
        'Attachments lack non-empty _wp_attachment_metadata; some media types may legitimately omit it.',
      count: 2,
    },
    {
      code: 'ORPHANED_ATTACHMENTS',
      message: 'Attachments reference parent posts that no longer exist.',
      count: 1,
    },
  ],
};

const empty: MediaAnalysis = {
  totalAttachments: 0,
  mimeTypeCounts: {},
  categoryCounts: {},
  missingAttachedFileMeta: 0,
  missingAttachmentMetadata: 0,
  unattachedAttachments: 0,
  orphanedAttachments: 0,
  externalMediaCount: 0,
  multisite: false,
  siteId: 1,
  warnings: [],
};

describe('migration_analyze_media', () => {
  let client: Client;
  let handle: StdioServerHandle;
  const analyze = vi.fn<MediaAnalyzer['analyze']>();
  const createAnalyzer = vi.fn<MediaAnalyzerFactory>();
  const call = () =>
    client.callTool({
      name: 'migration_analyze_media',
      arguments: { path: '/site' },
    });

  beforeEach(async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    analyze.mockReset().mockResolvedValue(structuredClone(summary));
    createAnalyzer.mockReset().mockReturnValue({ analyze });
    handle = startStdioServer(
      serverTransport,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createAnalyzer,
    );
    client = new Client({ name: 'media-test', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await handle.close();
  });

  it('advertises strict input, typed output, and read-only annotations without running analysis', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find(({ name }) => name === 'migration_analyze_media');
    expect(tool).toMatchObject({
      inputSchema: {
        type: 'object',
        required: ['path'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          totalAttachments: { type: 'integer' },
          maxAttachmentId: { type: 'integer' },
          mimeTypeCounts: {
            type: 'object',
            additionalProperties: { type: 'integer' },
          },
          categoryCounts: { type: 'object' },
          checkedLocalFiles: { type: 'integer' },
          usesYearMonthFolders: { type: 'boolean' },
          multisite: { type: 'boolean' },
          warnings: {
            type: 'array',
            items: {
              type: 'object',
              properties: { count: { type: 'integer' } },
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
    expect(tool?.description).toContain('Physical file checks are not enabled');
    expect(createAnalyzer).not.toHaveBeenCalled();
  });

  it('passes the unchanged path, invokes default summary mode, and preserves the complete domain result', async () => {
    const path = '/sites/my wordpress; $(echo literal)';
    const result = await client.callTool({
      name: 'migration_analyze_media',
      arguments: { path },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(summary);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ]);
    expect(createAnalyzer).toHaveBeenCalledExactlyOnceWith(path);
    expect(analyze).toHaveBeenCalledExactlyOnceWith();
    expect(result.structuredContent).not.toHaveProperty('missingLocalFiles');
    expect(result.structuredContent).not.toHaveProperty('checkedLocalFiles');
  });

  it('preserves zero attachments and omits unavailable optional fields', async () => {
    analyze.mockResolvedValueOnce(empty);
    const result = await call();
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(empty);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ]);
    for (const key of [
      'minAttachmentId',
      'maxAttachmentId',
      'missingLocalFiles',
      'checkedLocalFiles',
      'uploadBaseDir',
      'uploadBaseUrl',
      'usesYearMonthFolders',
    ]) {
      expect(result.structuredContent).not.toHaveProperty(key);
    }
  });

  it.each([0, 2])(
    'preserves optional file counts (%s) and structured warnings when supplied by the analyzer',
    async (missing) => {
      const info: MediaAnalysis = {
        ...summary,
        missingLocalFiles: missing,
        checkedLocalFiles: 10,
        warnings: [
          {
            code: 'MISSING_LOCAL_FILES',
            message:
              'Validated attachment paths have no local file. This can be intentional for offloaded media.',
            count: missing,
          },
        ],
      };
      analyze.mockResolvedValueOnce(info);
      const result = await call();
      expect(result.structuredContent).toEqual(info);
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify(result.structuredContent) },
      ]);
      // The MCP layer does not turn file inspection on to obtain these values.
      expect(analyze).toHaveBeenCalledExactlyOnceWith();
    },
  );

  it('preserves custom uploads, multisite scope, and a disabled year/month setting', async () => {
    const info = {
      ...summary,
      multisite: true,
      siteId: 3,
      usesYearMonthFolders: false,
    };
    analyze.mockResolvedValueOnce(info);
    expect((await call()).structuredContent).toEqual(info);
  });

  it('preserves unavailable-upload and filesystem warnings without inventing counts', async () => {
    const info: MediaAnalysis = {
      ...empty,
      warnings: [
        {
          code: 'LOCAL_FILE_CHECKS_UNAVAILABLE',
          message:
            'Local file checks were inconclusive because upload storage or filesystem metadata was unavailable.',
          count: 1,
        },
        {
          code: 'UPLOAD_CONFIGURATION_UNAVAILABLE',
          message:
            'Some upload configuration is unavailable from the WordPress runtime.',
        },
      ],
    };
    analyze.mockResolvedValueOnce(info);
    const result = await call();
    expect(result.structuredContent).toEqual(info);
    expect(result.structuredContent).not.toHaveProperty('warnings.1.count');
    expect(result.structuredContent).not.toHaveProperty('missingLocalFiles');
  });

  it('retains the empty MIME key used for an unspecified stored MIME type', async () => {
    const info = {
      ...summary,
      mimeTypeCounts: { '': 12 },
      categoryCounts: { other: 12 },
    };
    analyze.mockResolvedValueOnce(info);
    expect((await call()).structuredContent).toEqual(info);
  });

  it('preserves deterministic MIME/category/warning ordering without mutating the analyzer result', async () => {
    const info = structuredClone(summary);
    analyze.mockResolvedValue(info);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await call();
      const output = result.structuredContent as MediaAnalysis;
      expect(output).toEqual(summary);
      expect(Object.keys(output.mimeTypeCounts)).toEqual([
        'application/pdf',
        'image/jpeg',
        'image/png',
      ]);
      expect(Object.keys(output.categoryCounts)).toEqual([
        'application',
        'image',
      ]);
      expect(output.warnings.map(({ code }) => code)).toEqual(
        summary.warnings.map(({ code }) => code),
      );
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify(output) },
      ]);
    }
    expect(info).toEqual(summary);
  });

  it('strips individual paths, contents, environment data, and sensitive extras from output', async () => {
    const extras = {
      filePaths: ['/private/file'],
      contents: 'private file contents',
      environment: { DB_PASSWORD: 'private password' },
      authSecret: 'private auth',
      connection: 'mysql://root:private-password@db',
      stack: 'private stack',
    };
    analyze.mockResolvedValueOnce({
      ...summary,
      ...extras,
      warnings: summary.warnings.map((warning) => ({ ...warning, ...extras })),
    });
    const result = await call();
    expect(result.structuredContent).toEqual(summary);
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
    { path: '/site', checkLocalFiles: true },
    { path: '/site', file: '/private/file' },
    { path: '/site', command: 'db query' },
    { path: '/site', sql: 'SELECT 1' },
    { path: '/site', php: 'echo 1;' },
  ])('rejects invalid input %j before invoking the analyzer', async (args) => {
    const result = await client.callTool({
      name: 'migration_analyze_media',
      arguments: args,
    });
    expect(result.isError).toBe(true);
    expect(createAnalyzer).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
  });

  it.each([
    ['EXECUTABLE_NOT_FOUND', 'PATH'],
    ['TIMEOUT', 'timed out'],
    ['NON_ZERO_EXIT', 'database connectivity'],
    ['SPAWN_ERROR', 'permissions'],
    ['SIGNAL_TERMINATION', 'signal'],
    ['OUTPUT_LIMIT', 'capture limit'],
  ] satisfies [ProcessErrorCode, string][])(
    'sanitizes %s process errors with actionable guidance',
    async (code, guidance) => {
      analyze.mockRejectedValueOnce(
        new ProcessExecutionError(
          code,
          {
            stdout: 'private output',
            stderr: 'mysql://root:private-password@db',
            exitCode: 1,
            signal: null,
          },
          new Error('private cause'),
        ),
      );
      const result = await call();
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(code);
      expect(JSON.stringify(result)).toContain(guidance);
      expect(JSON.stringify(result)).not.toContain('private');
      expect(result.structuredContent).toBeUndefined();
    },
  );

  it.each(['EACCES', 'EPERM', 'ENOENT'])(
    'sanitizes filesystem error %s without leaking paths or stacks',
    async (code) => {
      analyze.mockRejectedValueOnce(
        Object.assign(new Error('private path and secrets'), {
          code,
          path: '/private/secret',
        }),
      );
      const result = await call();
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('FILESYSTEM_ACCESS_ERROR');
      expect(JSON.stringify(result)).toContain('permissions');
      expect(JSON.stringify(result)).not.toContain('private');
      expect(result.structuredContent).toBeUndefined();
    },
  );

  it.each([
    [
      new WpCliOutputError('eval', new Error('private output')),
      'INVALID_WP_CLI_OUTPUT',
    ],
    [new Error('private data'), 'INTERNAL_ERROR: Media analysis'],
  ])(
    'sanitizes malformed WP-CLI output and unexpected service failures',
    async (error, code) => {
      analyze.mockRejectedValueOnce(error);
      const result = await call();
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(code);
      expect(JSON.stringify(result)).not.toContain('private');
      expect(result.structuredContent).toBeUndefined();
    },
  );

  it('handles analyzer construction failures safely', async () => {
    createAnalyzer.mockImplementationOnce(() => {
      throw new Error('private data');
    });
    const result = await call();
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('INTERNAL_ERROR');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(analyze).not.toHaveBeenCalled();
  });

  it.each([
    { totalAttachments: -1 },
    { totalAttachments: 'private-count' },
    { maxAttachmentId: Number.MAX_SAFE_INTEGER + 1 },
    { minAttachmentId: 1.5 },
    { mimeTypeCounts: { 'image/jpeg': 'private count' } },
    { categoryCounts: [] },
    { missingLocalFiles: -1 },
    { usesYearMonthFolders: 'false' },
    { uploadBaseDir: { secret: 'private path' } },
    { warnings: [{ code: 'private-code', message: { secret: 'private' } }] },
  ])(
    'rejects malformed analyzer fields without echoing values',
    async (invalid) => {
      analyze.mockResolvedValueOnce({
        ...summary,
        ...invalid,
      } as unknown as MediaAnalysis);
      const result = await call();
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('INVALID_ANALYZER_RESPONSE');
      expect(JSON.stringify(result)).toContain('compatibility');
      expect(JSON.stringify(result)).not.toContain('private');
      expect(result.structuredContent).toBeUndefined();
    },
  );
});
