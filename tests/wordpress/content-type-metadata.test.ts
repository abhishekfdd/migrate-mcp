import { describe, expect, it, vi } from 'vitest';
import {
  WpCliClient,
  WpCliOutputError,
} from '../../src/wordpress/wp-cli-client.js';
import { contentTypeMetadataPhp } from '../../src/wordpress/content-type-metadata.js';
import {
  ProcessExecutionError,
  type runProcess,
} from '../../src/utils/process-runner.js';

const post = {
  name: 'post',
  label: 'Posts',
  description: '',
  public: true,
  publiclyQueryable: true,
  hierarchical: false,
  showUi: true,
  showInRest: true,
  restBase: 'posts',
  hasArchive: false,
  capabilityType: 'post',
  supports: ['title', 'editor', 'thumbnail'],
  builtIn: true,
  postCount: '12',
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

describe('WP-CLI content type metadata', () => {
  it('uses static inspection with plugins/themes loaded and CLI packages skipped', async () => {
    const { client, runner } = setup(JSON.stringify([post]));
    await expect(client.getContentTypeMetadata()).resolves.toEqual([
      { ...post, postCount: 12 },
    ]);
    expect(runner).toHaveBeenCalledExactlyOnceWith(
      '/tools/wp',
      [
        'eval',
        contentTypeMetadataPhp,
        '--path=/site; --exec=untrusted',
        '--no-color',
        '--skip-packages',
      ],
      { timeoutMs: 5000 },
    );
    expect(contentTypeMetadataPhp).toContain(
      "get_post_types(array(), 'objects')",
    );
    expect(contentTypeMetadataPhp).toContain(
      'get_all_post_type_supports($type->name)',
    );
    expect(contentTypeMetadataPhp).toContain('GROUP BY post_type');
    expect(contentTypeMetadataPhp).not.toMatch(
      /untrusted|\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/,
    );
  });

  it('preserves custom REST, rewrite, archive, and capability metadata', async () => {
    const custom = {
      ...post,
      name: 'book',
      label: 'Books',
      description: 'Library content',
      builtIn: false,
      hierarchical: true,
      restBase: 'library',
      rewriteSlug: 'catalog/books',
      hasArchive: 'catalog',
      capabilityType: ['book', 'books'],
      postCount: 7,
    };
    const { client } = setup(JSON.stringify([custom]));
    await expect(client.getContentTypeMetadata()).resolves.toEqual([custom]);
  });

  it('accepts absent optional metadata, empty supports, and zero counts', async () => {
    const minimal = {
      name: 'system_type',
      public: false,
      publiclyQueryable: false,
      hierarchical: false,
      showUi: false,
      showInRest: false,
      hasArchive: false,
      supports: [],
      builtIn: true,
      postCount: '0',
    };
    const { client } = setup(JSON.stringify([minimal]));
    await expect(client.getContentTypeMetadata()).resolves.toEqual([
      { ...minimal, postCount: 0 },
    ]);
  });

  it('accepts an empty runtime registry', async () => {
    const { client } = setup('[]');
    await expect(client.getContentTypeMetadata()).resolves.toEqual([]);
  });

  it.each([
    'not json',
    'null',
    '{}',
    JSON.stringify([post, post]),
    ...[
      { name: '' },
      { public: 'true' },
      { builtIn: 1 },
      { supports: 'title,editor' },
      { supports: [false] },
      { hasArchive: {} },
      { restBase: false },
      { capabilityType: {} },
      { postCount: null },
      { postCount: '12 posts' },
      { postCount: '1.5' },
      { postCount: -1 },
      { postCount: 1.5 },
      { postCount: '9007199254740992' },
    ].map((invalid) => JSON.stringify([{ ...post, ...invalid }])),
  ])('rejects malformed metadata %s', async (stdout) => {
    const { client } = setup(stdout);
    await expect(client.getContentTypeMetadata()).rejects.toBeInstanceOf(
      WpCliOutputError,
    );
  });

  it('propagates count-query or process failures instead of reporting zero posts', async () => {
    const { runner, client } = setup('');
    const error = new ProcessExecutionError(
      'NON_ZERO_EXIT',
      {
        stdout: '',
        stderr: 'Unable to count posts',
        exitCode: 1,
        signal: null,
      },
      new Error('failed'),
    );
    runner.mockRejectedValueOnce(error);
    await expect(client.getContentTypeMetadata()).rejects.toBe(error);
  });
});
