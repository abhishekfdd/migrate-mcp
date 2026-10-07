import { describe, expect, it, vi } from 'vitest';
import {
  WpCliClient,
  WpCliOutputError,
} from '../../src/wordpress/wp-cli-client.js';
import {
  mediaMetadataPhp,
  attachmentFileReferencesPhp,
} from '../../src/wordpress/media-inspection.js';
import {
  ProcessExecutionError,
  type runProcess,
} from '../../src/utils/process-runner.js';

const metadata = {
  totalAttachments: '3',
  minAttachmentId: '1',
  maxAttachmentId: '9007199254740991',
  mimeTypeCounts: { 'video/mp4': '1', 'image/jpeg': '2' },
  missingAttachedFileMeta: '1',
  missingAttachmentMetadata: '2',
  unattachedAttachments: '1',
  orphanedAttachments: '1',
  externalMediaCount: '1',
  uploadBaseDir: '/custom/uploads',
  uploadBaseUrl: 'https://media.example.test',
  usesYearMonthFolders: true,
  multisite: false,
  siteId: '1',
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
  return { client, runner };
}

describe('WP-CLI media metadata', () => {
  it('uses controlled inspection, loads upload filters, and parses numeric summaries', async () => {
    const { client, runner } = setup(JSON.stringify(metadata));
    await expect(client.getMediaMetadata()).resolves.toMatchObject({
      totalAttachments: 3,
      minAttachmentId: 1,
      maxAttachmentId: Number.MAX_SAFE_INTEGER,
      mimeTypeCounts: { 'video/mp4': 1, 'image/jpeg': 2 },
      missingAttachedFileMeta: 1,
      missingAttachmentMetadata: 2,
      unattachedAttachments: 1,
      orphanedAttachments: 1,
      externalMediaCount: 1,
      siteId: 1,
    });
    expect(runner).toHaveBeenCalledExactlyOnceWith(
      '/tools/wp',
      [
        'eval',
        mediaMetadataPhp,
        '--path=/site; --exec=untrusted',
        '--no-color',
        '--skip-packages',
      ],
      { timeoutMs: 5000 },
    );
    expect(mediaMetadataPhp).toContain('wp_upload_dir(null, false)');
    expect(mediaMetadataPhp).toContain('$wpdb->posts');
    expect(mediaMetadataPhp).toContain('MIN(m.meta_id)');
    expect(mediaMetadataPhp).toContain('p.post_parent <> 0');
    expect(mediaMetadataPhp).not.toMatch(
      /untrusted|SELECT \*|switch_to_blog|wp_mkdir|file_get_contents|\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/,
    );
  });

  it('handles an empty installation with no upload configuration', async () => {
    const { client } = setup(
      JSON.stringify({
        totalAttachments: '0',
        minAttachmentId: null,
        maxAttachmentId: null,
        mimeTypeCounts: {},
        missingAttachedFileMeta: '0',
        missingAttachmentMetadata: '0',
        unattachedAttachments: '0',
        orphanedAttachments: '0',
        externalMediaCount: '0',
        multisite: true,
        siteId: '3',
      }),
    );
    const result = await client.getMediaMetadata();
    expect(result).toMatchObject({
      totalAttachments: 0,
      mimeTypeCounts: {},
      multisite: true,
      siteId: 3,
    });
    expect(result.minAttachmentId).toBeUndefined();
    expect(result.maxAttachmentId).toBeUndefined();
    expect(result.uploadBaseDir).toBeUndefined();
    expect(result.usesYearMonthFolders).toBeUndefined();
  });

  it.each([true, false])(
    'preserves the year/month option %s and site-specific custom uploads',
    async (enabled) => {
      const { client } = setup(
        JSON.stringify({
          ...metadata,
          usesYearMonthFolders: enabled,
          multisite: true,
          siteId: 3,
          uploadBaseDir: '/media/tenant-three',
          uploadBaseUrl: 'https://cdn.example.test/site-3',
        }),
      );
      await expect(client.getMediaMetadata()).resolves.toMatchObject({
        usesYearMonthFolders: enabled,
        multisite: true,
        siteId: 3,
        uploadBaseDir: '/media/tenant-three',
        uploadBaseUrl: 'https://cdn.example.test/site-3',
      });
    },
  );

  it.each([
    'not json',
    'null',
    '[]',
    '{}',
    ...[
      { totalAttachments: -1 },
      { totalAttachments: true },
      { totalAttachments: '3 files' },
      { minAttachmentId: null },
      { maxAttachmentId: '9007199254740992' },
      { minAttachmentId: 8, maxAttachmentId: 7 },
      { totalAttachments: 0, mimeTypeCounts: {} },
      { mimeTypeCounts: [] },
      { mimeTypeCounts: { 'image/jpeg': 'many' } },
      { mimeTypeCounts: { 'image/jpeg': 2 } },
      { mimeTypeCounts: { 'image/jpeg': -1, 'video/mp4': 4 } },
      { missingAttachedFileMeta: 4 },
      { missingAttachmentMetadata: -1 },
      { unattachedAttachments: 3 },
      { orphanedAttachments: 4 },
      { externalMediaCount: 4 },
      { siteId: 0 },
      { multisite: 'false' },
      { usesYearMonthFolders: '1' },
      { uploadBaseDir: false },
    ].map((bad) => JSON.stringify({ ...metadata, ...bad })),
  ])('rejects malformed summary %s', async (stdout) => {
    const { client } = setup(stdout);
    await expect(client.getMediaMetadata()).rejects.toBeInstanceOf(
      WpCliOutputError,
    );
  });

  it('strips unrelated fields rather than forwarding arbitrary database data', async () => {
    const { client } = setup(
      JSON.stringify({
        ...metadata,
        records: [{ private: 'secret' }],
        password: 'secret',
      }),
    );
    expect(JSON.stringify(await client.getMediaMetadata())).not.toContain(
      'secret',
    );
  });

  it('reads bounded reference pages with numeric-only cursors outside the WordPress path', async () => {
    const rows = [
      { id: '0', attachedFile: '' },
      { id: '1', attachedFile: '2026/10/image.jpg' },
      { id: '8', attachedFile: null },
    ];
    const { client, runner } = setup(JSON.stringify(rows));
    await expect(client.getAttachmentFileReferences(-1, 8)).resolves.toEqual(
      rows.map((row) => ({ ...row, id: Number(row.id) })),
    );
    const php = attachmentFileReferencesPhp(-1, 8);
    expect(runner).toHaveBeenCalledExactlyOnceWith(
      '/tools/wp',
      [
        'eval',
        php,
        '--path=/site; --exec=untrusted',
        '--no-color',
        '--skip-packages',
      ],
      { timeoutMs: 5000 },
    );
    expect(php).toContain('ORDER BY p.ID LIMIT 100');
    expect(php).toContain('OCTET_LENGTH(f.meta_value) > 1024');
    expect(php).toContain('p.ID > %d AND p.ID <= %d');
    expect(php).not.toContain('untrusted');
  });

  it.each([
    [-2, 5],
    [2, 1],
    [0.5, 1],
    [-1, -1],
    [0, Infinity],
    [0, Number.MAX_SAFE_INTEGER + 1],
    ['0; echo secret', 1],
  ])(
    'rejects unsafe cursors %j %j before execution',
    async (after, through) => {
      const { client, runner } = setup('[]');
      await expect(
        client.getAttachmentFileReferences(after as number, through as number),
      ).rejects.toBeInstanceOf(TypeError);
      expect(runner).not.toHaveBeenCalled();
    },
  );

  it.each([
    'not json',
    '{}',
    'null',
    ...[
      [{ id: 2, attachedFile: 1 }],
      [{ id: 2, attachedFile: 'x'.repeat(1025) }],
      [{ id: 1, attachedFile: '' }],
      [{ id: 5, attachedFile: '' }],
      [
        { id: 2, attachedFile: '' },
        { id: 2, attachedFile: '' },
      ],
      [
        { id: 3, attachedFile: '' },
        { id: 2, attachedFile: '' },
      ],
      Array.from({ length: 101 }, (_, i) => ({ id: i + 2, attachedFile: '' })),
    ].map((bad) => JSON.stringify(bad)),
  ])('rejects malformed, oversized, or unordered page %s', async (stdout) => {
    const { client } = setup(stdout);
    await expect(
      client.getAttachmentFileReferences(1, 4),
    ).rejects.toBeInstanceOf(WpCliOutputError);
  });

  it('accepts the last empty page', async () => {
    await expect(
      setup('[]').client.getAttachmentFileReferences(4, 4),
    ).resolves.toEqual([]);
  });

  it.each(['summary', 'references'])(
    'preserves %s process errors',
    async (method) => {
      const { client, runner } = setup('');
      const error = new ProcessExecutionError(
        'NON_ZERO_EXIT',
        {
          stdout: '',
          stderr: 'private',
          exitCode: 1,
          signal: null,
        },
        new Error('private failure'),
      );
      runner.mockRejectedValueOnce(error);
      await expect(
        method === 'summary'
          ? client.getMediaMetadata()
          : client.getAttachmentFileReferences(-1, 4),
      ).rejects.toBe(error);
    },
  );
});
