import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UrlReferenceAnalyzerFactory } from '../../src/mcp/urls-tool.js';
import { startStdioServer } from '../../src/mcp/stdio.js';
import type {
  UrlReferenceAnalyzer,
  UrlReferenceAnalysis,
} from '../../src/migration/url-reference-analyzer.js';
import {
  ProcessExecutionError,
  type ProcessErrorCode,
} from '../../src/utils/process-runner.js';
import { WpCliOutputError } from '../../src/wordpress/wp-cli-client.js';
import {
  referenceMetadata,
  emptyReferenceMetadata,
} from '../fixtures/url-reference-metadata.js';

const urls = {
  siteUrl: 'https://www.example.com/wp',
  homeUrl: 'https://example.com/blog',
  uploadBaseUrl: 'https://cdn.example.com/uploads',
};
const summary: UrlReferenceAnalysis = {
  ...referenceMetadata,
  ...urls,
  hostCounts: {
    'cdn.example.com': 1,
    'example.com': 1,
    localhost: 1,
    'other.example.org': 1,
    'www.example.com': 2,
  },
  locations: [...referenceMetadata.locations].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : 0,
  ),
  warnings: [
    {
      code: 'DEVELOPMENT_URL_REFERENCES',
      message:
        'Local or development hostname indicators were found; their intended use is not verified.',
      count: 1,
    },
    {
      code: 'EXTERNAL_MEDIA_HOSTS',
      message:
        'External media/CDN indicators were found; external hosting is not itself a migration problem.',
      count: 1,
    },
    {
      code: 'FILESYSTEM_PATH_REFERENCES',
      message:
        'Absolute filesystem path indicators were found; paths were not accessed or returned.',
      count: 2,
    },
    {
      code: 'HTTP_REFERENCES_FOUND',
      message:
        'Plain HTTP references may need review for the destination environment.',
      count: 2,
    },
    {
      code: 'SERIALIZED_URL_REFERENCES',
      message:
        'Likely PHP serialized values contain URLs. Future changes must preserve serialization lengths.',
      count: 2,
    },
    {
      code: 'SOURCE_DOMAIN_REFERENCES_FOUND',
      message:
        'References use the configured site or home hostname; review them when planning a domain change.',
      count: 3,
    },
  ],
};
const empty: UrlReferenceAnalysis = {
  ...emptyReferenceMetadata,
  ...urls,
  locations: summary.locations.map(({ source }) => ({
    source,
    referenceCount: 0,
  })),
  warnings: [],
};

describe('migration_analyze_urls', () => {
  let client: Client;
  let handle: StdioServerHandle;
  const analyze = vi.fn<UrlReferenceAnalyzer['analyze']>();
  const createAnalyzer = vi.fn<UrlReferenceAnalyzerFactory>();
  const call = () =>
    client.callTool({
      name: 'migration_analyze_urls',
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
      undefined,
      createAnalyzer,
    );
    client = new Client({ name: 'urls-test', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await handle.close();
  });

  it('advertises strict input, typed summaries, and read-only annotations without analyzing', async () => {
    const { tools } = await client.listTools();
    expect(
      tools.find(({ name }) => name === 'migration_analyze_urls'),
    ).toMatchObject({
      inputSchema: {
        type: 'object',
        required: ['path'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          totalReferences: { type: 'integer' },
          hostCounts: {
            type: 'object',
            additionalProperties: { type: 'integer' },
          },
          multisite: { type: 'boolean' },
          alternateSourceHosts: { type: 'array' },
          locations: {
            type: 'array',
            items: {
              type: 'object',
              properties: { referenceCount: { type: 'integer' } },
            },
          },
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
    expect(createAnalyzer).not.toHaveBeenCalled();
  });

  it('passes the unchanged path and returns the complete domain result with numeric counts', async () => {
    const path = '/sites/my wordpress; $(echo literal)';
    const result = await client.callTool({
      name: 'migration_analyze_urls',
      arguments: { path },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(summary);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ]);
    expect(createAnalyzer).toHaveBeenCalledExactlyOnceWith(path);
    expect(analyze).toHaveBeenCalledExactlyOnceWith();
    expect(result.structuredContent).toMatchObject({
      sourceUrlReferences: 3,
      externalUrlReferences: 3,
      httpReferences: 2,
      httpsReferences: 3,
      protocolRelativeReferences: 1,
      serializedValueReferences: 2,
      jsonValueReferences: 1,
      filesystemPathReferences: 2,
      developmentReferenceCount: 1,
    });
  });

  it('preserves zero references, empty host maps, and zero-count locations', async () => {
    analyze.mockResolvedValueOnce(empty);
    const result = await call();
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(empty);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ]);
  });

  it('keeps optional URL configuration and warning counts absent', async () => {
    const info = structuredClone(empty);
    delete info.siteUrl;
    delete info.homeUrl;
    delete info.uploadBaseUrl;
    info.warnings = [
      {
        code: 'REFERENCE_CONFIGURATION_UNAVAILABLE',
        message:
          'Some site/home/upload URL configuration was unavailable or unsupported; related counts may be incomplete.',
      },
    ];
    analyze.mockResolvedValueOnce(info);
    const result = await call();
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(info);
    for (const key of [
      'siteUrl',
      'homeUrl',
      'uploadBaseUrl',
      'warnings.0.count',
    ])
      expect(result.structuredContent).not.toHaveProperty(key);
  });

  it('preserves scope, alternate hosts, skipped-value counts, and scan-limit warnings', async () => {
    const info: UrlReferenceAnalysis = {
      ...empty,
      multisite: false,
      siteId: 1,
      totalReferences: 2,
      externalUrlReferences: 2,
      httpsReferences: 2,
      unreportedHostReferences: 2,
      alternateSourceHosts: ['example.org', 'www.example.net'],
      skippedSensitiveValues: 4,
      skippedOversizedValues: 3,
      skippedBinaryValues: 1,
      locations: empty.locations.map((location, index) => ({
        ...location,
        referenceCount: index === 0 ? 2 : 0,
      })),
      warnings: [
        {
          code: 'HOST_SUMMARY_LIMIT',
          message:
            'The host summary limit was reached; these occurrences remain in totals but are absent from host maps.',
          count: 2,
        },
        {
          code: 'OVERSIZED_VALUES_SKIPPED',
          message:
            'Text values larger than 64 KiB were skipped; reference totals are incomplete.',
          count: 3,
        },
      ],
    };
    analyze.mockResolvedValueOnce(info);
    expect((await call()).structuredContent).toEqual(info);
  });

  it('preserves analyzer ordering and repeated output without mutating the service result', async () => {
    const info = structuredClone(summary);
    analyze.mockResolvedValue(info);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await call();
      const output = result.structuredContent as UrlReferenceAnalysis;
      expect(output).toEqual(summary);
      expect(Object.keys(output.hostCounts)).toEqual([
        'cdn.example.com',
        'example.com',
        'localhost',
        'other.example.org',
        'www.example.com',
      ]);
      expect(output.locations.map(({ source }) => source)).toEqual(
        summary.locations.map(({ source }) => source),
      );
      expect(output.warnings.map(({ code }) => code)).toEqual(
        summary.warnings.map(({ code }) => code),
      );
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify(output) },
      ]);
    }
    expect(info).toEqual(summary);
  });

  it('removes raw matches and sensitive extras from the summary and nested locations/warnings', async () => {
    const extras = {
      rows: [
        {
          post_content: 'private post',
          option_value: 'private option',
          meta_value: 'private meta',
        },
      ],
      matchedValue: 'private match',
      sql: 'SELECT private',
      environment: { DB_PASSWORD: 'private password' },
      connection: 'mysql://root:private-password@db',
      authSecret: 'private auth',
      stack: 'private stack',
    };
    analyze.mockResolvedValueOnce({
      ...summary,
      ...extras,
      locations: summary.locations.map((location) => ({
        ...location,
        ...extras,
      })),
      warnings: summary.warnings.map((warning) => ({ ...warning, ...extras })),
    });
    const result = await call();
    expect(result.isError).not.toBe(true);
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
    { path: null },
    { path: 123 },
    { path: 'relative/path' },
    { path: '/site\0invalid' },
    { path: '/site', sql: 'SELECT 1' },
    { path: '/site', command: 'db query' },
    { path: '/site', php: 'echo 1;' },
    { path: '/site', includeRows: true },
    { path: '/site', targetUrl: 'https://other.example' },
  ])('rejects invalid input %j before invoking the analyzer', async (args) => {
    const result = await client.callTool({
      name: 'migration_analyze_urls',
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
    'translates %s into sanitized actionable guidance',
    async (code, guidance) => {
      analyze.mockRejectedValueOnce(
        new ProcessExecutionError(
          code,
          {
            stdout: 'private raw matches',
            stderr: 'mysql://root:private-password@db SELECT private',
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

  it.each([
    [
      new WpCliOutputError(
        'eval',
        new Error('private database metadata failure'),
      ),
      'INVALID_WP_CLI_OUTPUT',
      'compatibility',
    ],
    [
      new Error('private database failure'),
      'INTERNAL_ERROR',
      'URL/reference analysis',
    ],
  ])(
    'sanitizes service/output errors without exposing their cause',
    async (error, code, guidance) => {
      analyze.mockRejectedValueOnce(error);
      const result = await call();
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(code);
      expect(JSON.stringify(result)).toContain(guidance);
      expect(JSON.stringify(result)).not.toContain('private');
      expect(result.structuredContent).toBeUndefined();
    },
  );

  it('sanitizes analyzer construction failures', async () => {
    createAnalyzer.mockImplementationOnce(() => {
      throw new Error('private failure');
    });
    const result = await call();
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('INTERNAL_ERROR');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(analyze).not.toHaveBeenCalled();
  });

  it.each([
    { totalReferences: -1 },
    { totalReferences: 'private count' },
    { totalReferences: Number.MAX_SAFE_INTEGER + 1 },
    { totalReferences: 7 },
    { serializedValueReferences: 7 },
    { jsonValueReferences: true },
    { filesystemPathReferences: 1.5 },
    { hostCounts: { 'private-user:private-pass@host': 6 } },
    { hostCounts: { 'example.org': 'private count' } },
    { locations: [{ source: 'private row', referenceCount: 6 }] },
    { siteUrl: 'https://private-user:private-pass@example.com/' },
    { homeUrl: 'https://example.com/?token=private' },
    { uploadBaseUrl: 'https://example.com/#private' },
    { warnings: [{ code: 'private', message: { rawContent: 'private' } }] },
    { warnings: [{ code: 'private', message: 'private', count: -1 }] },
  ])(
    'rejects malformed or unsafe analyzer output without exposing values',
    async (invalid) => {
      analyze.mockResolvedValueOnce({
        ...summary,
        ...invalid,
      } as unknown as UrlReferenceAnalysis);
      const result = await call();
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.stringify(result)).toContain('INVALID_ANALYZER_RESPONSE');
      expect(JSON.stringify(result)).toContain('compatibility');
      expect(JSON.stringify(result)).not.toContain('private');
    },
  );
});
