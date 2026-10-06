import { describe, expect, it, vi } from 'vitest';
import {
  ContentTypeAnalyzer,
  type ContentTypeInfo,
} from '../../src/migration/content-type-analyzer.js';
import {
  WpCliClient,
  WpCliOutputError,
} from '../../src/wordpress/wp-cli-client.js';
import type { runProcess } from '../../src/utils/process-runner.js';

const post: ContentTypeInfo = {
  name: 'post',
  label: 'Posts',
  public: true,
  publiclyQueryable: true,
  hierarchical: false,
  showUi: true,
  showInRest: true,
  restBase: 'posts',
  hasArchive: false,
  supports: ['title', 'editor', 'thumbnail'],
  builtIn: true,
  postCount: 12,
};

describe('ContentTypeAnalyzer', () => {
  it('includes built-in, hierarchical, custom, and internal types in deterministic order', async () => {
    const types: ContentTypeInfo[] = [
      post,
      {
        ...post,
        name: 'revision',
        label: 'Revisions',
        public: false,
        publiclyQueryable: false,
        showUi: false,
        showInRest: false,
        postCount: 40,
      },
      {
        ...post,
        name: 'page',
        label: 'Pages',
        hierarchical: true,
        restBase: 'pages',
        postCount: 3,
      },
      {
        ...post,
        name: 'book',
        label: 'Books',
        description: 'Library',
        builtIn: false,
        restBase: 'library',
        rewriteSlug: 'catalog/books',
        hasArchive: 'catalog',
        capabilityType: ['book', 'books'],
        postCount: 0,
      },
      { ...post, name: 'attachment', label: 'Media', postCount: 6 },
    ];
    const original = structuredClone(types);
    const client = {
      getContentTypeMetadata: vi
        .fn<WpCliClient['getContentTypeMetadata']>()
        .mockResolvedValue(types),
    };
    const analyzer = new ContentTypeAnalyzer(client);
    const result = await analyzer.analyze();
    expect(result.map((type) => type.name)).toEqual([
      'attachment',
      'book',
      'page',
      'post',
      'revision',
    ]);
    expect(result.find((type) => type.name === 'book')).toMatchObject({
      builtIn: false,
      showInRest: true,
      restBase: 'library',
      rewriteSlug: 'catalog/books',
      postCount: 0,
    });
    expect(result.find((type) => type.name === 'page')).toMatchObject({
      hierarchical: true,
      builtIn: true,
    });
    expect(result.find((type) => type.name === 'revision')).toMatchObject({
      public: false,
      postCount: 40,
    });
    expect(result.find((type) => type.name === 'post')?.supports).toEqual([
      'editor',
      'thumbnail',
      'title',
    ]);
    expect(types).toEqual(original);
    expect(client.getContentTypeMetadata).toHaveBeenCalledExactlyOnceWith();
    client.getContentTypeMetadata.mockResolvedValueOnce([...types].reverse());
    await expect(analyzer.analyze()).resolves.toEqual(result);
  });

  it('works through the real adapter with mocked WP-CLI output', async () => {
    const runner = vi.fn<typeof runProcess>().mockResolvedValue({
      stdout: JSON.stringify([{ ...post, postCount: '25' }]),
      stderr: '',
      exitCode: 0,
      signal: null,
    });
    const analyzer = new ContentTypeAnalyzer(
      new WpCliClient({ wordpressPath: '/site' }, runner),
    );
    await expect(analyzer.analyze()).resolves.toEqual([
      { ...post, postCount: 25, supports: ['editor', 'thumbnail', 'title'] },
    ]);
  });

  it('returns an empty list when no types are registered', async () => {
    const analyzer = new ContentTypeAnalyzer({
      getContentTypeMetadata: vi.fn().mockResolvedValue([]),
    });
    await expect(analyzer.analyze()).resolves.toEqual([]);
  });

  it('propagates malformed output errors', async () => {
    const error = new WpCliOutputError('eval (content type metadata)');
    const analyzer = new ContentTypeAnalyzer({
      getContentTypeMetadata: vi.fn().mockRejectedValue(error),
    });
    await expect(analyzer.analyze()).rejects.toBe(error);
  });
});
