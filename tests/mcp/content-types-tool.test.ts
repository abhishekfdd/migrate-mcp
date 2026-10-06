import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentTypeAnalyzerFactory } from '../../src/mcp/content-types-tool.js';
import { startStdioServer } from '../../src/mcp/stdio.js';
import type {
  ContentTypeAnalyzer,
  ContentTypeInfo,
} from '../../src/migration/content-type-analyzer.js';
import {
  ProcessExecutionError,
  type ProcessErrorCode,
} from '../../src/utils/process-runner.js';
import { WpCliOutputError } from '../../src/wordpress/wp-cli-client.js';

const internalType: ContentTypeInfo = {
  name: 'revision',
  public: false,
  publiclyQueryable: false,
  hierarchical: false,
  showUi: false,
  showInRest: false,
  hasArchive: false,
  supports: [],
  builtIn: true,
  postCount: 0,
};

const contentTypes: ContentTypeInfo[] = [
  {
    ...internalType,
    name: 'attachment',
    label: 'Media',
    public: true,
    showUi: true,
    showInRest: true,
    capabilityType: 'post',
    supports: ['author', 'comments', 'title'],
    postCount: 18420,
  },
  {
    name: 'movie',
    label: 'Movies',
    description: 'Movie content',
    public: true,
    publiclyQueryable: true,
    hierarchical: true,
    showUi: true,
    showInRest: true,
    restBase: 'movies',
    hasArchive: 'movie-archive',
    rewriteSlug: 'movie',
    capabilityType: ['movie', 'movies'],
    supports: ['editor', 'thumbnail', 'title'],
    builtIn: false,
    postCount: 842,
  },
  internalType,
];

describe('migration_list_content_types', () => {
  let client: Client;
  let handle: StdioServerHandle;
  const analyze = vi.fn<ContentTypeAnalyzer['analyze']>();
  const createAnalyzer = vi.fn<ContentTypeAnalyzerFactory>();

  beforeEach(async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    analyze.mockReset().mockResolvedValue(structuredClone(contentTypes));
    createAnalyzer.mockReset().mockReturnValue({ analyze });
    handle = startStdioServer(
      serverTransport,
      undefined,
      undefined,
      createAnalyzer,
    );
    client = new Client({ name: 'content-types-test', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await handle.close();
  });

  it('advertises strict input, typed array output, and read-only annotations', async () => {
    const { tools } = await client.listTools();
    expect(
      tools.find((tool) => tool.name === 'migration_list_content_types'),
    ).toMatchObject({
      inputSchema: {
        type: 'object',
        required: ['path'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          contentTypes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                public: { type: 'boolean' },
                supports: { type: 'array', items: { type: 'string' } },
                postCount: { type: 'integer' },
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

  it('passes the unchanged path and preserves built-in, custom, and internal metadata', async () => {
    const path = '/sites/my wordpress; $(echo literal)';
    const result = await client.callTool({
      name: 'migration_list_content_types',
      arguments: { path },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ contentTypes });
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ]);
    expect(createAnalyzer).toHaveBeenCalledExactlyOnceWith(path);
    expect(analyze).toHaveBeenCalledExactlyOnceWith();
  });

  it('preserves zero counts and omits absent optional metadata', async () => {
    analyze.mockResolvedValueOnce([internalType]);
    const result = await client.callTool({
      name: 'migration_list_content_types',
      arguments: { path: '/site' },
    });
    expect(result.structuredContent).toEqual({ contentTypes: [internalType] });
    expect(result.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({ contentTypes: [internalType] }),
      },
    ]);
  });

  it('preserves the analyzer ordering on repeated calls without mutating its results', async () => {
    const types = structuredClone(contentTypes);
    analyze.mockResolvedValue(types);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await client.callTool({
        name: 'migration_list_content_types',
        arguments: { path: '/site' },
      });
      expect(result.structuredContent).toEqual({ contentTypes });
    }
    expect(types).toEqual(contentTypes);
  });

  it('returns an empty structured list when the analyzer finds no types', async () => {
    analyze.mockResolvedValueOnce([]);
    const result = await client.callTool({
      name: 'migration_list_content_types',
      arguments: { path: '/site' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ contentTypes: [] });
  });

  it.each([
    {},
    { path: '' },
    { path: '  ' },
    { path: 123 },
    { path: null },
    { path: 'relative/path' },
    { path: '/site\0invalid' },
    { path: '/site', command: 'post delete' },
    { path: '/site', php: 'echo 1;' },
  ])('rejects invalid input %j before creating the analyzer', async (args) => {
    const result = await client.callTool({
      name: 'migration_list_content_types',
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
        name: 'migration_list_content_types',
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
    [new Error('private data'), 'INTERNAL_ERROR: Content type information'],
  ])(
    'sanitizes WP-CLI output and unexpected analyzer errors',
    async (error, code) => {
      analyze.mockRejectedValueOnce(error);
      const result = await client.callTool({
        name: 'migration_list_content_types',
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
      name: 'migration_list_content_types',
      arguments: { path: '/site' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('INTERNAL_ERROR');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(analyze).not.toHaveBeenCalled();
  });

  it('rejects invalid analyzer counts instead of returning invalid structured output', async () => {
    analyze.mockResolvedValueOnce([{ ...internalType, postCount: -1 }]);
    const result = await client.callTool({
      name: 'migration_list_content_types',
      arguments: { path: '/site' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });
});
