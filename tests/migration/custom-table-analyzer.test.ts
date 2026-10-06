import { describe, expect, it, vi } from 'vitest';
import { CustomTableAnalyzer } from '../../src/migration/custom-table-analyzer.js';
import { tableMetadataSchema } from '../../src/wordpress/table-metadata.js';
import {
  WpCliOutputError,
  type WpCliClient,
} from '../../src/wordpress/wp-cli-client.js';

const blogTables = [
  'posts',
  'postmeta',
  'comments',
  'commentmeta',
  'terms',
  'term_taxonomy',
  'term_relationships',
  'termmeta',
  'options',
  'links',
];
const singleCore = [...blogTables, 'users', 'usermeta'].map(
  (name) => `wp_${name}`,
);
const networkCore = [
  ...singleCore,
  ...[2, 3].flatMap((id) => blogTables.map((name) => `wp_${id}_${name}`)),
  ...[
    'blogs',
    'blogmeta',
    'site',
    'sitemeta',
    'signups',
    'registration_log',
  ].map((name) => `wp_${name}`),
];

function setup(names: string[], overrides: Record<string, unknown> = {}) {
  const metadata = tableMetadataSchema.parse({
    basePrefix: 'wp_',
    tablePrefix: 'wp_',
    multisite: false,
    sites: [{ id: 1, prefix: 'wp_' }],
    coreTables: singleCore,
    tables: names.map((name) => ({ name })),
    ...overrides,
  });
  const client = {
    getTableMetadata: vi
      .fn<WpCliClient['getTableMetadata']>()
      .mockResolvedValue(metadata),
  };
  return { analyzer: new CustomTableAnalyzer(client), client, metadata };
}

const multisite = {
  multisite: true,
  tablePrefix: 'wp_2_',
  coreTables: networkCore,
  sites: [
    { id: 1, prefix: 'wp_' },
    { id: 2, prefix: 'wp_2_' },
    { id: 3, prefix: 'wp_3_' },
  ],
};

describe('CustomTableAnalyzer', () => {
  it('excludes all single-site core tables and detects a custom table', async () => {
    const { analyzer, client } = setup([...singleCore, 'wp_plugin_events']);
    await expect(analyzer.analyze()).resolves.toEqual([
      {
        name: 'wp_plugin_events',
        logicalName: 'plugin_events',
        usesWordPressPrefix: true,
        scope: 'site',
        siteSpecific: true,
        siteId: 1,
      },
    ]);
    expect(client.getTableMetadata).toHaveBeenCalledExactlyOnceWith();
  });

  it('excludes main-site, subsite, and network core tables using runtime names', async () => {
    const { analyzer } = setup(networkCore, multisite);
    await expect(analyzer.analyze()).resolves.toEqual([]);
  });

  it('handles custom subsite tables and distinguishes current versus other site prefixes', async () => {
    const { analyzer } = setup(
      [...networkCore, 'wp_3_plugin_events', 'wp_2_gf_entry'],
      multisite,
    );
    await expect(analyzer.analyze()).resolves.toEqual([
      {
        name: 'wp_2_gf_entry',
        logicalName: 'gf_entry',
        usesWordPressPrefix: true,
        scope: 'site',
        siteSpecific: true,
        siteId: 2,
        likelyOwner: 'Gravity Forms',
      },
      {
        name: 'wp_3_plugin_events',
        logicalName: 'plugin_events',
        usesWordPressPrefix: false,
        scope: 'site',
        siteSpecific: true,
        siteId: 3,
      },
    ]);
  });

  it('leaves global versus main-site custom ownership ambiguous', async () => {
    const { analyzer } = setup(
      ['wp_network_events', 'wp_actionscheduler_actions'],
      multisite,
    );
    await expect(analyzer.analyze()).resolves.toEqual([
      {
        name: 'wp_actionscheduler_actions',
        logicalName: 'actionscheduler_actions',
        usesWordPressPrefix: false,
        scope: 'network-or-main-site',
        likelyOwner: 'Action Scheduler',
      },
      {
        name: 'wp_network_events',
        logicalName: 'network_events',
        usesWordPressPrefix: false,
        scope: 'network-or-main-site',
      },
    ]);
  });

  it('does not assign unknown numeric prefixes to registered sites or core tables', async () => {
    const { analyzer } = setup(
      ['wp_99_posts', 'wp_20_plugin_events'],
      multisite,
    );
    await expect(analyzer.analyze()).resolves.toEqual([
      {
        name: 'wp_20_plugin_events',
        logicalName: '20_plugin_events',
        usesWordPressPrefix: false,
        scope: 'unknown',
      },
      {
        name: 'wp_99_posts',
        logicalName: '99_posts',
        usesWordPressPrefix: false,
        scope: 'unknown',
      },
    ]);
  });

  it('preserves unprefixed tables without guessing a logical name, site, or owner', async () => {
    const { analyzer } = setup(['external_records', 'gf_entry']);
    await expect(analyzer.analyze()).resolves.toEqual([
      {
        name: 'external_records',
        usesWordPressPrefix: false,
        scope: 'unprefixed',
      },
      { name: 'gf_entry', usesWordPressPrefix: false, scope: 'unprefixed' },
    ]);
  });

  it('excludes overridden user tables and newly registered core names from the runtime list', async () => {
    const { analyzer } = setup(
      ['shared_users', 'shared_usermeta', 'wp_future_core', 'wp_events'],
      {
        coreTables: ['shared_users', 'shared_usermeta', 'wp_future_core'],
      },
    );
    expect((await analyzer.analyze()).map((table) => table.name)).toEqual([
      'wp_events',
    ]);
  });

  it.each([
    ['wp_actionscheduler_actions', 'Action Scheduler'],
    ['wp_gf_entry', 'Gravity Forms'],
    ['wp_woocommerce_order_items', 'WooCommerce'],
    ['wp_unknown_data', undefined],
    ['wp_notwoocommerce_items', undefined],
  ])('infers conservative owner hints for %s', async (name, owner) => {
    const { analyzer } = setup([name]);
    expect((await analyzer.analyze())[0]?.likelyOwner).toBe(owner);
  });

  it('preserves numeric metadata estimates and zero sizes', async () => {
    const { analyzer } = setup([], {
      tables: [
        {
          name: 'wp_events',
          rowCount: '0',
          sizeBytes: '16384',
          dataSizeBytes: 16384,
          indexSizeBytes: '0',
          engine: 'InnoDB',
          collation: 'utf8mb4_unicode_ci',
          referenceColumns: ['user_id', 'post_id'],
        },
      ],
    });
    await expect(analyzer.analyze()).resolves.toEqual([
      {
        name: 'wp_events',
        logicalName: 'events',
        usesWordPressPrefix: true,
        scope: 'site',
        siteSpecific: true,
        siteId: 1,
        rowCount: 0,
        sizeBytes: 16384,
        dataSizeBytes: 16384,
        indexSizeBytes: 0,
        engine: 'InnoDB',
        collation: 'utf8mb4_unicode_ci',
        referenceHints: [
          { column: 'post_id', possibleTarget: 'posts' },
          { column: 'user_id', possibleTarget: 'users' },
        ],
      },
    ]);
  });

  it('omits unavailable metadata and keeps successful empty reference discovery', async () => {
    const { analyzer } = setup([], {
      tables: [
        {
          name: 'wp_events',
          rowCount: null,
          sizeBytes: null,
          dataSizeBytes: null,
          indexSizeBytes: null,
          engine: null,
          collation: null,
          referenceColumns: [],
        },
      ],
    });
    await expect(analyzer.analyze()).resolves.toEqual([
      {
        name: 'wp_events',
        logicalName: 'events',
        usesWordPressPrefix: true,
        scope: 'site',
        siteSpecific: true,
        siteId: 1,
        referenceHints: [],
      },
    ]);
  });

  it('sorts tables and reference hints deterministically without mutating metadata', async () => {
    const { analyzer, metadata, client } = setup([], {
      tables: [
        {
          name: 'wp_z',
          referenceColumns: ['user_id', 'POST_ID', 'unknown_column'],
        },
        { name: 'wp_a' },
      ],
    });
    const original = structuredClone(metadata);
    const result = await analyzer.analyze();
    expect(result.map((table) => table.name)).toEqual(['wp_a', 'wp_z']);
    expect(result[1]?.referenceHints).toEqual([
      { column: 'POST_ID', possibleTarget: 'posts' },
      { column: 'user_id', possibleTarget: 'users' },
    ]);
    expect(metadata).toEqual(original);
    client.getTableMetadata.mockResolvedValueOnce({
      ...metadata,
      tables: [...metadata.tables].reverse(),
    });
    await expect(analyzer.analyze()).resolves.toEqual(result);
  });

  it('supports custom prefixes without assuming wp_', async () => {
    const { analyzer } = setup(['custom_2_posts', 'custom_2_plugin_events'], {
      ...multisite,
      basePrefix: 'custom_',
      tablePrefix: 'custom_2_',
      sites: [
        { id: 1, prefix: 'custom_' },
        { id: 2, prefix: 'custom_2_' },
      ],
      coreTables: ['custom_2_posts'],
    });
    await expect(analyzer.analyze()).resolves.toEqual([
      {
        name: 'custom_2_plugin_events',
        logicalName: 'plugin_events',
        usesWordPressPrefix: true,
        scope: 'site',
        siteSpecific: true,
        siteId: 2,
      },
    ]);
  });

  it('keeps empty-prefix scope uncertain', async () => {
    const { analyzer } = setup(['events'], {
      basePrefix: '',
      tablePrefix: '',
      sites: [{ id: 1, prefix: '' }],
      coreTables: [],
    });
    await expect(analyzer.analyze()).resolves.toEqual([
      {
        name: 'events',
        logicalName: 'events',
        usesWordPressPrefix: true,
        scope: 'unknown',
      },
    ]);
  });

  it('propagates malformed adapter output without returning a partial list', async () => {
    const { analyzer, client } = setup([]);
    const error = new WpCliOutputError('eval (table metadata)');
    client.getTableMetadata.mockRejectedValueOnce(error);
    await expect(analyzer.analyze()).rejects.toBe(error);
  });
});
