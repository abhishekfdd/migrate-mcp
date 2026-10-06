import { describe, expect, it, vi } from 'vitest';
import {
  TaxonomyAnalyzer,
  type TaxonomyInfo,
} from '../../src/migration/taxonomy-analyzer.js';
import {
  WpCliClient,
  WpCliOutputError,
} from '../../src/wordpress/wp-cli-client.js';
import type { runProcess } from '../../src/utils/process-runner.js';

const category: TaxonomyInfo = {
  name: 'category',
  label: 'Categories',
  public: true,
  publiclyQueryable: true,
  hierarchical: true,
  showUi: true,
  showInRest: true,
  restBase: 'categories',
  builtIn: true,
  objectTypes: ['post'],
  termCount: 12,
};

describe('TaxonomyAnalyzer', () => {
  it('includes built-in, custom, flat, hierarchical, and internal taxonomies', async () => {
    const taxonomies: TaxonomyInfo[] = [
      {
        ...category,
        name: 'post_tag',
        label: 'Tags',
        hierarchical: false,
        restBase: 'tags',
        termCount: 4,
      },
      {
        ...category,
        name: 'genre',
        label: 'Genres',
        description: 'Library genres',
        builtIn: false,
        restBase: 'library-genres',
        rewriteSlug: 'library/genre',
        objectTypes: ['post', 'movie', 'book'],
        termCount: 7,
      },
      category,
      {
        ...category,
        name: 'mood',
        label: 'Moods',
        hierarchical: false,
        builtIn: false,
        restBase: 'moods',
        objectTypes: ['movie'],
        termCount: 0,
      },
      {
        ...category,
        name: 'nav_menu',
        label: 'Navigation Menus',
        public: false,
        publiclyQueryable: false,
        hierarchical: false,
        showUi: false,
        showInRest: false,
        objectTypes: ['nav_menu_item'],
        termCount: 2,
      },
    ];
    const original = structuredClone(taxonomies);
    const client = {
      getTaxonomyMetadata: vi
        .fn<WpCliClient['getTaxonomyMetadata']>()
        .mockResolvedValue(taxonomies),
    };
    const result = await new TaxonomyAnalyzer(client).analyze();
    expect(result.map((taxonomy) => taxonomy.name)).toEqual([
      'category',
      'genre',
      'mood',
      'nav_menu',
      'post_tag',
    ]);
    expect(result.find((taxonomy) => taxonomy.name === 'category')).toEqual(
      category,
    );
    expect(result.find((taxonomy) => taxonomy.name === 'genre')).toMatchObject({
      builtIn: false,
      hierarchical: true,
      showInRest: true,
      restBase: 'library-genres',
      rewriteSlug: 'library/genre',
      objectTypes: ['book', 'movie', 'post'],
      termCount: 7,
    });
    expect(result.find((taxonomy) => taxonomy.name === 'mood')).toMatchObject({
      builtIn: false,
      hierarchical: false,
      objectTypes: ['movie'],
      termCount: 0,
    });
    expect(
      result.find((taxonomy) => taxonomy.name === 'post_tag'),
    ).toMatchObject({
      builtIn: true,
      hierarchical: false,
    });
    expect(
      result.find((taxonomy) => taxonomy.name === 'nav_menu'),
    ).toMatchObject({
      builtIn: true,
      public: false,
      objectTypes: ['nav_menu_item'],
    });
    expect(taxonomies).toEqual(original);
    expect(client.getTaxonomyMetadata).toHaveBeenCalledExactlyOnceWith();

    client.getTaxonomyMetadata.mockResolvedValueOnce(
      [...taxonomies].reverse().map((taxonomy) => ({
        ...taxonomy,
        objectTypes: [...taxonomy.objectTypes].reverse(),
      })),
    );
    await expect(new TaxonomyAnalyzer(client).analyze()).resolves.toEqual(
      result,
    );
  });

  it('works through the adapter with mocked numeric WP-CLI output', async () => {
    const runner = vi.fn<typeof runProcess>().mockResolvedValue({
      stdout: JSON.stringify([{ ...category, termCount: '25' }]),
      stderr: '',
      exitCode: 0,
      signal: null,
    });
    const analyzer = new TaxonomyAnalyzer(
      new WpCliClient({ wordpressPath: '/site' }, runner),
    );
    await expect(analyzer.analyze()).resolves.toEqual([
      { ...category, termCount: 25 },
    ]);
  });

  it('preserves unassociated taxonomies without optional metadata', async () => {
    const minimal: TaxonomyInfo = {
      name: 'internal_taxonomy',
      public: false,
      publiclyQueryable: false,
      hierarchical: false,
      showUi: false,
      showInRest: false,
      builtIn: false,
      objectTypes: [],
      termCount: 0,
    };
    const analyzer = new TaxonomyAnalyzer({
      getTaxonomyMetadata: vi.fn().mockResolvedValue([minimal]),
    });
    await expect(analyzer.analyze()).resolves.toEqual([minimal]);
  });

  it('returns an empty list when no taxonomies are registered', async () => {
    const analyzer = new TaxonomyAnalyzer({
      getTaxonomyMetadata: vi.fn().mockResolvedValue([]),
    });
    await expect(analyzer.analyze()).resolves.toEqual([]);
  });

  it('propagates malformed output errors', async () => {
    const error = new WpCliOutputError('eval (taxonomy metadata)');
    const analyzer = new TaxonomyAnalyzer({
      getTaxonomyMetadata: vi.fn().mockRejectedValue(error),
    });
    await expect(analyzer.analyze()).rejects.toBe(error);
  });
});
