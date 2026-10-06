import { describe, expect, it, vi } from 'vitest';
import {
  WpCliClient,
  WpCliOutputError,
} from '../../src/wordpress/wp-cli-client.js';
import { tableMetadataPhp } from '../../src/wordpress/table-metadata.js';
import {
  ProcessExecutionError,
  type runProcess,
} from '../../src/utils/process-runner.js';

const metadata = {
  basePrefix: 'wp_',
  tablePrefix: 'wp_',
  multisite: false,
  sites: [{ id: '1', prefix: 'wp_' }],
  coreTables: ['wp_posts', 'wp_users'],
  tables: [
    {
      name: 'wp_plugin_events',
      rowCount: '120',
      sizeBytes: '24576',
      dataSizeBytes: '16384',
      indexSizeBytes: '8192',
      engine: 'InnoDB',
      collation: 'utf8mb4_unicode_ci',
      referenceColumns: ['post_id', 'user_id'],
    },
  ],
};

function setup(stdout: string) {
  const runner = vi.fn<typeof runProcess>().mockResolvedValue({
    stdout,
    stderr: '',
    exitCode: 0,
    signal: null,
  });
  const client = new WpCliClient(
    {
      wordpressPath: '/site; --exec=untrusted',
      wpBinaryPath: '/tools/wp',
      timeoutMs: 5000,
    },
    runner,
  );
  return { client, runner };
}

describe('WP-CLI table metadata', () => {
  it('reads fixed metadata with safe arguments and parses numeric fields', async () => {
    const { client, runner } = setup(JSON.stringify(metadata));
    await expect(client.getTableMetadata()).resolves.toEqual({
      ...metadata,
      sites: [{ id: 1, prefix: 'wp_' }],
      tables: [
        {
          ...metadata.tables[0],
          rowCount: 120,
          sizeBytes: 24576,
          dataSizeBytes: 16384,
          indexSizeBytes: 8192,
        },
      ],
    });
    expect(runner).toHaveBeenCalledExactlyOnceWith(
      '/tools/wp',
      [
        'eval',
        tableMetadataPhp,
        '--path=/site; --exec=untrusted',
        '--no-color',
        '--skip-plugins',
        '--skip-themes',
        '--skip-packages',
      ],
      { timeoutMs: 5000 },
    );
    expect(tableMetadataPhp).toContain('information_schema.TABLES');
    expect(tableMetadataPhp).toContain('information_schema.COLUMNS');
    expect(tableMetadataPhp).toContain("get_class_vars('wpdb')");
    expect(tableMetadataPhp).toContain("$wpdb->tables('all', true, $blog_id)");
    expect(tableMetadataPhp).not.toMatch(
      /untrusted|COUNT\(\*\)|SELECT \*|\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/,
    );
  });

  it.each([null, undefined])(
    'accepts missing optional metadata (%s)',
    async (missing) => {
      const { client } = setup(
        JSON.stringify({
          ...metadata,
          tables: [
            {
              name: 'wp_events',
              rowCount: missing,
              sizeBytes: missing,
              dataSizeBytes: missing,
              indexSizeBytes: missing,
              engine: missing,
              collation: missing,
            },
          ],
        }),
      );
      const result = await client.getTableMetadata();
      expect(result.tables[0]).toMatchObject({ name: 'wp_events' });
      expect(result.tables[0]?.rowCount).toBeUndefined();
      expect(result.tables[0]?.sizeBytes).toBeUndefined();
      expect(result.tables[0]?.engine).toBeUndefined();
      expect(result.tables[0]?.referenceColumns).toBeUndefined();
    },
  );

  it('preserves zero values and normalizes empty optional strings', async () => {
    const { client } = setup(
      JSON.stringify({
        ...metadata,
        tables: [
          {
            name: 'wp_events',
            rowCount: '0',
            sizeBytes: 0,
            dataSizeBytes: '0',
            indexSizeBytes: 0,
            engine: '',
            collation: '',
            referenceColumns: [],
          },
        ],
      }),
    );
    const result = await client.getTableMetadata();
    expect(result.tables[0]).toMatchObject({
      rowCount: 0,
      sizeBytes: 0,
      dataSizeBytes: 0,
      indexSizeBytes: 0,
      referenceColumns: [],
    });
    expect(result.tables[0]?.engine).toBeUndefined();
    expect(result.tables[0]?.collation).toBeUndefined();
  });

  it('accepts an empty table list', async () => {
    const { client } = setup(JSON.stringify({ ...metadata, tables: [] }));
    expect((await client.getTableMetadata()).tables).toEqual([]);
  });

  it.each([
    'not json',
    'null',
    '[]',
    '{}',
    ...[
      { basePrefix: 'invalid-prefix' },
      { tablePrefix: null },
      { multisite: 'true' },
      { sites: [] },
      { sites: [{ id: 0, prefix: 'wp_' }] },
      {
        sites: [
          { id: 1, prefix: 'wp_' },
          { id: 1, prefix: 'wp_2_' },
        ],
      },
      {
        sites: [
          { id: 1, prefix: 'wp_' },
          { id: 2, prefix: 'wp_' },
        ],
      },
      { coreTables: ['wp_posts', 'wp_posts'] },
      { coreTables: null },
      { tables: {} },
      { tables: [{ name: '' }] },
      { tables: [{ name: 'wp_events' }, { name: 'wp_events' }] },
    ].map((invalid) => JSON.stringify({ ...metadata, ...invalid })),
    ...[
      { rowCount: '12 rows' },
      { rowCount: -1 },
      { rowCount: 1.5 },
      { rowCount: true },
      { sizeBytes: '9007199254740992' },
      { dataSizeBytes: '-1' },
      { indexSizeBytes: {} },
      { engine: [] },
      { collation: false },
      { referenceColumns: 'post_id' },
      { referenceColumns: ['post_id', 'post_id'] },
    ].map((invalid) =>
      JSON.stringify({
        ...metadata,
        tables: [{ name: 'wp_events', ...invalid }],
      }),
    ),
  ])('rejects malformed metadata %s', async (stdout) => {
    const { client } = setup(stdout);
    await expect(client.getTableMetadata()).rejects.toBeInstanceOf(
      WpCliOutputError,
    );
  });

  it('propagates required metadata and process failures', async () => {
    const { client, runner } = setup('');
    const error = new ProcessExecutionError(
      'NON_ZERO_EXIT',
      {
        stdout: '',
        stderr: 'Unable to enumerate blogs',
        exitCode: 1,
        signal: null,
      },
      new Error('failed'),
    );
    runner.mockRejectedValueOnce(error);
    await expect(client.getTableMetadata()).rejects.toBe(error);
  });
});
