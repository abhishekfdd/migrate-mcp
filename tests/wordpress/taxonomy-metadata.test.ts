import { describe, expect, it, vi } from 'vitest';
import {
  WpCliClient,
  WpCliOutputError,
} from '../../src/wordpress/wp-cli-client.js';
import { taxonomyMetadataPhp } from '../../src/wordpress/taxonomy-metadata.js';
import {
  ProcessExecutionError,
  type runProcess,
} from '../../src/utils/process-runner.js';

const category = {
  name: 'category',
  label: 'Categories',
  description: '',
  public: true,
  publiclyQueryable: true,
  hierarchical: true,
  showUi: true,
  showInRest: true,
  restBase: 'categories',
  rewriteSlug: 'category',
  builtIn: true,
  objectTypes: ['post'],
  termCount: '12',
};

function setup(stdout: string) {
  const runner = vi
    .fn<typeof runProcess>()
    .mockResolvedValue({ stdout, stderr: '', exitCode: 0, signal: null });
  const client = new WpCliClient(
    {
      wordpressPath: '/site; --exec=untrusted',
      wpBinaryPath: '/tools/wp',
      timeoutMs: 5000,
    },
    runner,
  );
  return { runner, client };
}

describe('WP-CLI taxonomy metadata', () => {
  it('uses static inspection with plugins/themes loaded and CLI packages skipped', async () => {
    const { client, runner } = setup(JSON.stringify([category]));
    await expect(client.getTaxonomyMetadata()).resolves.toEqual([
      { ...category, termCount: 12 },
    ]);
    expect(runner).toHaveBeenCalledExactlyOnceWith(
      '/tools/wp',
      [
        'eval',
        taxonomyMetadataPhp,
        '--path=/site; --exec=untrusted',
        '--no-color',
        '--skip-packages',
      ],
      { timeoutMs: 5000 },
    );
    expect(taxonomyMetadataPhp).toContain("get_taxonomies(array(), 'objects')");
    expect(taxonomyMetadataPhp).toContain('$taxonomy->_builtin');
    expect(taxonomyMetadataPhp).toContain(
      'array_values($taxonomy->object_type)',
    );
    expect(taxonomyMetadataPhp).toContain('$wpdb->term_taxonomy');
    expect(taxonomyMetadataPhp).toContain(
      'SELECT taxonomy, COUNT(*) AS term_count',
    );
    expect(taxonomyMetadataPhp).toContain('GROUP BY taxonomy');
    expect(taxonomyMetadataPhp).not.toMatch(
      /untrusted|\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/,
    );
  });

  it('preserves custom REST, rewrite, hierarchy, and multiple object types', async () => {
    const custom = {
      ...category,
      name: 'genre',
      label: 'Genres',
      description: 'Library genres',
      builtIn: false,
      restBase: 'library-genres',
      rewriteSlug: 'library/genre',
      objectTypes: ['movie', 'book'],
      termCount: 7,
    };
    const { client } = setup(JSON.stringify([custom]));
    await expect(client.getTaxonomyMetadata()).resolves.toEqual([custom]);
  });

  it('accepts absent optional metadata, no object types, and zero terms', async () => {
    const minimal = {
      name: 'internal_taxonomy',
      public: false,
      publiclyQueryable: false,
      hierarchical: false,
      showUi: false,
      showInRest: false,
      builtIn: true,
      objectTypes: [],
      termCount: '0',
    };
    const { client } = setup(JSON.stringify([minimal]));
    await expect(client.getTaxonomyMetadata()).resolves.toEqual([
      { ...minimal, termCount: 0 },
    ]);
  });

  it.each([0, '0', 123, '123', Number.MAX_SAFE_INTEGER, '9007199254740991'])(
    'returns count %j as a number without precision loss',
    async (termCount) => {
      const { client } = setup(JSON.stringify([{ ...category, termCount }]));
      await expect(client.getTaxonomyMetadata()).resolves.toEqual([
        { ...category, termCount: Number(termCount) },
      ]);
    },
  );

  it('accepts an empty runtime registry', async () => {
    const { client } = setup('[]');
    await expect(client.getTaxonomyMetadata()).resolves.toEqual([]);
  });

  it.each([
    'not json',
    'null',
    '{}',
    '[{}]',
    JSON.stringify([category, category]),
    ...[
      { name: '' },
      { public: 'true' },
      { publiclyQueryable: null },
      { hierarchical: 'false' },
      { showUi: 1 },
      { showInRest: null },
      { builtIn: 1 },
      { objectTypes: 'post' },
      { objectTypes: [false] },
      { objectTypes: [''] },
      { objectTypes: { 1: 'post' } },
      { restBase: false },
      { rewriteSlug: {} },
      { label: null },
      { description: [] },
      { termCount: null },
      { termCount: true },
      { termCount: '' },
      { termCount: '12 terms' },
      { termCount: '1.5' },
      { termCount: '-1' },
      { termCount: -1 },
      { termCount: 1.5 },
      { termCount: '9007199254740992' },
    ].map((invalid) => JSON.stringify([{ ...category, ...invalid }])),
  ])('rejects malformed metadata %s', async (stdout) => {
    const { client } = setup(stdout);
    await expect(client.getTaxonomyMetadata()).rejects.toBeInstanceOf(
      WpCliOutputError,
    );
  });

  it('propagates count-query or process failures instead of reporting zero terms', async () => {
    const { runner, client } = setup('');
    const error = new ProcessExecutionError(
      'NON_ZERO_EXIT',
      {
        stdout: '',
        stderr: 'Unable to count terms',
        exitCode: 1,
        signal: null,
      },
      new Error('failed'),
    );
    runner.mockRejectedValueOnce(error);
    await expect(client.getTaxonomyMetadata()).rejects.toBe(error);
  });
});
