import { describe, expect, it, vi } from 'vitest';
import { MediaAnalyzer } from '../../src/migration/media-analyzer.js';
import { mediaMetadataSchema } from '../../src/wordpress/media-metadata.js';
import {
  MediaFileInspector,
  type MediaFileStatus,
} from '../../src/wordpress/media-file-inspector.js';
import {
  WpCliOutputError,
  type WpCliClient,
} from '../../src/wordpress/wp-cli-client.js';

const metadata = {
  totalAttachments: 4,
  minAttachmentId: 1,
  maxAttachmentId: 50,
  mimeTypeCounts: { 'video/mp4': 1, 'image/png': 1, 'image/jpeg': 2 },
  missingAttachedFileMeta: 0,
  missingAttachmentMetadata: 0,
  unattachedAttachments: 2,
  orphanedAttachments: 0,
  externalMediaCount: 0,
  uploadBaseDir: '/custom/media',
  uploadBaseUrl: 'https://example.test/media',
  usesYearMonthFolders: true,
  multisite: false,
  siteId: 1,
};

function setup(overrides: Record<string, unknown> = {}) {
  const response = mediaMetadataSchema.parse({ ...metadata, ...overrides });
  const client = {
    getMediaMetadata: vi
      .fn<WpCliClient['getMediaMetadata']>()
      .mockResolvedValue(response),
    getAttachmentFileReferences: vi
      .fn<WpCliClient['getAttachmentFileReferences']>()
      .mockResolvedValue([
        { id: 1, attachedFile: 'one.jpg' },
        { id: 2, attachedFile: 'two.jpg' },
        { id: 3, attachedFile: 'three.png' },
        { id: 50, attachedFile: 'last.mp4' },
      ]),
  };
  const inspect = vi
    .fn<MediaFileInspector['inspect']>()
    .mockResolvedValue('present');
  const createInspector = vi.fn().mockReturnValue({ inspect });
  return {
    analyzer: new MediaAnalyzer(client, createInspector),
    client,
    inspect,
    createInspector,
    response,
  };
}

describe('MediaAnalyzer', () => {
  it('returns deterministic MIME/category summaries without loading references by default', async () => {
    const { analyzer, client, createInspector, response } = setup();
    const original = structuredClone(response);
    const result = await analyzer.analyze();
    expect(result).toEqual({
      ...metadata,
      mimeTypeCounts: { 'image/jpeg': 2, 'image/png': 1, 'video/mp4': 1 },
      categoryCounts: { image: 3, video: 1 },
      warnings: [
        { code: 'LOCAL_FILES_NOT_CHECKED', message: expect.any(String) },
      ],
    });
    expect(Object.keys(result.mimeTypeCounts)).toEqual([
      'image/jpeg',
      'image/png',
      'video/mp4',
    ]);
    expect(result).not.toHaveProperty('missingLocalFiles');
    expect(result).not.toHaveProperty('checkedLocalFiles');
    expect(client.getMediaMetadata).toHaveBeenCalledExactlyOnceWith();
    expect(client.getAttachmentFileReferences).not.toHaveBeenCalled();
    expect(createInspector).not.toHaveBeenCalled();
    expect(response).toEqual(original);
    client.getMediaMetadata.mockResolvedValue({
      ...response,
      mimeTypeCounts: { 'image/png': 1, 'video/mp4': 1, 'image/jpeg': 2 },
    });
    await expect(analyzer.analyze()).resolves.toEqual(result);
  });

  it('handles zero attachments without requesting a reference page', async () => {
    const { analyzer, client } = setup({
      totalAttachments: 0,
      minAttachmentId: null,
      maxAttachmentId: null,
      mimeTypeCounts: {},
      unattachedAttachments: 0,
    });
    const result = await analyzer.analyze({ checkLocalFiles: true });
    expect(result).toMatchObject({
      totalAttachments: 0,
      mimeTypeCounts: {},
      categoryCounts: {},
      missingLocalFiles: 0,
      checkedLocalFiles: 0,
      warnings: [],
    });
    expect(result).not.toHaveProperty('minAttachmentId');
    expect(result).not.toHaveProperty('maxAttachmentId');
    expect(client.getAttachmentFileReferences).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'preserves year/month setting %s and custom active-site multisite uploads',
    async (enabled) => {
      const { analyzer, createInspector, client } = setup({
        usesYearMonthFolders: enabled,
        multisite: true,
        siteId: 3,
        uploadBaseDir: '/media/tenant-3',
        uploadBaseUrl: 'https://cdn.test/three',
      });
      await expect(
        analyzer.analyze({ checkLocalFiles: true }),
      ).resolves.toMatchObject({
        usesYearMonthFolders: enabled,
        multisite: true,
        siteId: 3,
        uploadBaseDir: '/media/tenant-3',
        uploadBaseUrl: 'https://cdn.test/three',
      });
      expect(createInspector).toHaveBeenCalledExactlyOnceWith(
        '/media/tenant-3',
      );
      expect(
        client.getAttachmentFileReferences,
      ).toHaveBeenCalledExactlyOnceWith(-1, 50);
    },
  );

  it('keeps missing metadata, missing parents, and unattached records separate', async () => {
    const { analyzer } = setup({
      missingAttachedFileMeta: 1,
      missingAttachmentMetadata: 2,
      orphanedAttachments: 1,
    });
    const result = await analyzer.analyze();
    expect(result).toMatchObject({
      missingAttachedFileMeta: 1,
      missingAttachmentMetadata: 2,
      orphanedAttachments: 1,
      unattachedAttachments: 2,
    });
    expect(result.warnings.map(({ code, count }) => ({ code, count }))).toEqual(
      [
        { code: 'LOCAL_FILES_NOT_CHECKED', count: undefined },
        { code: 'MISSING_ATTACHED_FILE_META', count: 1 },
        { code: 'MISSING_ATTACHMENT_METADATA', count: 2 },
        { code: 'ORPHANED_ATTACHMENTS', count: 1 },
      ],
    );
    expect(
      result.warnings.some(({ code }) => code.includes('UNATTACHED')),
    ).toBe(false);
  });

  it('counts only definitive missing files and reports skipped references separately', async () => {
    const { analyzer, inspect } = setup();
    inspect
      .mockResolvedValueOnce('missing')
      .mockResolvedValueOnce('present')
      .mockResolvedValueOnce('unsafe')
      .mockResolvedValueOnce('unavailable');
    const result = await analyzer.analyze({ checkLocalFiles: true });
    expect(result).toMatchObject({
      missingLocalFiles: 1,
      checkedLocalFiles: 2,
    });
    expect(result.warnings.map(({ code, count }) => ({ code, count }))).toEqual(
      [
        { code: 'LOCAL_FILE_CHECKS_UNAVAILABLE', count: 1 },
        { code: 'MISSING_LOCAL_FILES', count: 1 },
        { code: 'UNSAFE_ATTACHMENT_PATHS', count: 1 },
      ],
    );
  });

  it.each(['unsafe', 'unavailable'] satisfies MediaFileStatus[])(
    'omits missing-file count when all checks are %s',
    async (status) => {
      const { analyzer, inspect } = setup();
      inspect.mockResolvedValue(status);
      const result = await analyzer.analyze({ checkLocalFiles: true });
      expect(result.checkedLocalFiles).toBe(0);
      expect(result).not.toHaveProperty('missingLocalFiles');
    },
  );

  it('does not interpret missing local files or absent metadata as offload evidence', async () => {
    const { analyzer, inspect } = setup({
      externalMediaCount: 1,
      missingAttachedFileMeta: 1,
    });
    inspect
      .mockResolvedValueOnce('external')
      .mockResolvedValueOnce('no-reference')
      .mockResolvedValueOnce('missing')
      .mockResolvedValueOnce('present');
    const result = await analyzer.analyze({ checkLocalFiles: true });
    expect(result).toMatchObject({
      externalMediaCount: 1,
      missingLocalFiles: 1,
      checkedLocalFiles: 2,
    });
    expect(result.warnings).toContainEqual({
      code: 'EXTERNAL_MEDIA_REFERENCES',
      count: 1,
      message: expect.any(String),
    });
  });

  it('omits unavailable optional upload settings and warns', async () => {
    const { analyzer } = setup({
      uploadBaseDir: undefined,
      uploadBaseUrl: undefined,
      usesYearMonthFolders: undefined,
    });
    const result = await analyzer.analyze();
    for (const key of [
      'uploadBaseDir',
      'uploadBaseUrl',
      'usesYearMonthFolders',
    ])
      expect(result).not.toHaveProperty(key);
    expect(result.warnings).toContainEqual({
      code: 'UPLOAD_CONFIGURATION_UNAVAILABLE',
      message: expect.any(String),
    });
  });

  it('paginates without accumulating records or inspecting IDs added above the initial maximum', async () => {
    const { analyzer, client, inspect } = setup({
      totalAttachments: 101,
      maxAttachmentId: 1000,
      mimeTypeCounts: { 'image/jpeg': 101 },
    });
    client.getAttachmentFileReferences
      .mockResolvedValueOnce(
        Array.from({ length: 100 }, (_, i) => ({
          id: i + 1,
          attachedFile: `${i}.jpg`,
        })),
      )
      .mockResolvedValueOnce([{ id: 1000, attachedFile: 'last.jpg' }]);
    await expect(
      analyzer.analyze({ checkLocalFiles: true }),
    ).resolves.toMatchObject({
      checkedLocalFiles: 101,
      missingLocalFiles: 0,
      warnings: [],
    });
    expect(client.getAttachmentFileReferences.mock.calls).toEqual([
      [-1, 1000],
      [100, 1000],
    ]);
    expect(inspect).toHaveBeenCalledTimes(101);
  });

  it('warns about attachments removed during inspection', async () => {
    const { analyzer, client } = setup();
    client.getAttachmentFileReferences.mockResolvedValueOnce([]);
    const result = await analyzer.analyze({ checkLocalFiles: true });
    expect(result).not.toHaveProperty('missingLocalFiles');
    expect(result.warnings).toContainEqual({
      code: 'ATTACHMENTS_CHANGED_DURING_ANALYSIS',
      message: expect.any(String),
    });
  });

  it('groups unknown or absent MIME types as other and sorts categories', async () => {
    const { analyzer } = setup({
      mimeTypeCounts: {
        '': 1,
        'application/pdf': 1,
        'audio/mpeg': 1,
        'text/plain': 1,
      },
    });
    const result = await analyzer.analyze();
    expect(result.categoryCounts).toEqual({
      application: 1,
      audio: 1,
      other: 1,
      text: 1,
    });
    expect(Object.keys(result.categoryCounts)).toEqual([
      'application',
      'audio',
      'other',
      'text',
    ]);
  });

  it('integrates filesystem checks with mocked WP-CLI and filesystem metadata only', async () => {
    const { client } = setup();
    client.getAttachmentFileReferences.mockResolvedValueOnce([
      { id: 1, attachedFile: '2026/10/image.jpg' },
      { id: 2, attachedFile: '../secret' },
      { id: 3, attachedFile: 'https://cdn.test/remote.jpg' },
      { id: 50, attachedFile: '' },
    ]);
    const dir = {
      isFile: () => false,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    };
    const fs = {
      realpath: vi.fn().mockResolvedValue('/custom/media'),
      lstat: vi.fn().mockImplementation(async (path: string) => {
        if (path.endsWith('.jpg'))
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return dir;
      }),
    };
    const analyzer = new MediaAnalyzer(
      client,
      (base) => new MediaFileInspector(base, fs),
    );
    const result = await analyzer.analyze({ checkLocalFiles: true });
    expect(result).toMatchObject({
      missingLocalFiles: 1,
      checkedLocalFiles: 1,
    });
    expect(fs.lstat).toHaveBeenLastCalledWith(
      '/custom/media/2026/10/image.jpg',
    );
    expect(fs.lstat).toHaveBeenCalledTimes(4);
    expect(result.warnings).toContainEqual({
      code: 'UNSAFE_ATTACHMENT_PATHS',
      message: expect.any(String),
      count: 1,
    });
  });

  it.each(['summary', 'references'])(
    'propagates %s failures instead of returning partial success',
    async (method) => {
      const { analyzer, client } = setup();
      const error = new WpCliOutputError('eval (media metadata)');
      (method === 'summary'
        ? client.getMediaMetadata
        : client.getAttachmentFileReferences
      ).mockRejectedValueOnce(error);
      await expect(analyzer.analyze({ checkLocalFiles: true })).rejects.toBe(
        error,
      );
    },
  );
});
