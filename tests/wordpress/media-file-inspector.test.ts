import { describe, expect, it, vi } from 'vitest';
import {
  MediaFileInspector,
  type MediaFileSystem,
} from '../../src/wordpress/media-file-inspector.js';

const directory = {
  isDirectory: () => true,
  isFile: () => false,
  isSymbolicLink: () => false,
};
const file = {
  isDirectory: () => false,
  isFile: () => true,
  isSymbolicLink: () => false,
};
const symlink = {
  isDirectory: () => false,
  isFile: () => false,
  isSymbolicLink: () => true,
};
const error = (code: string) =>
  Object.assign(new Error('private path detail'), { code });

function setup(base: string | undefined = '/custom/uploads') {
  const fs = {
    realpath: vi
      .fn<MediaFileSystem['realpath']>()
      .mockResolvedValue('/storage/uploads'),
    lstat: vi
      .fn<MediaFileSystem['lstat']>()
      .mockImplementation(async (path) =>
        path.endsWith('.jpg') ? file : directory,
      ),
  };
  return { fs, inspector: new MediaFileInspector(base, fs) };
}

describe('MediaFileInspector', () => {
  it('resolves relative paths against custom uploads and caches only the trusted root', async () => {
    const { inspector, fs } = setup();
    await expect(inspector.inspect('2026/10/image.jpg')).resolves.toBe(
      'present',
    );
    await expect(inspector.inspect('2026/10/another.jpg')).resolves.toBe(
      'present',
    );
    expect(fs.realpath).toHaveBeenCalledExactlyOnceWith('/custom/uploads');
    expect(fs.lstat.mock.calls.map(([path]) => path)).toEqual([
      '/storage/uploads',
      '/storage/uploads/2026',
      '/storage/uploads/2026/10',
      '/storage/uploads/2026/10/image.jpg',
      '/storage/uploads/2026',
      '/storage/uploads/2026/10',
      '/storage/uploads/2026/10/another.jpg',
    ]);
  });

  it('accepts legacy absolute paths only inside the configured upload directory', async () => {
    const { inspector, fs } = setup();
    await expect(inspector.inspect('/custom/uploads/image.jpg')).resolves.toBe(
      'present',
    );
    expect(fs.lstat).toHaveBeenLastCalledWith('/storage/uploads/image.jpg');
  });

  it.each([
    '../secret',
    '2026/../../secret',
    '/etc/passwd',
    '/custom/uploads-other/file',
    '2026/../file.jpg',
    '2026\\..\\secret',
    'file:///etc/passwd',
    'php://filter/resource=secret',
    'C:\\secret.jpg',
    'image\0.jpg',
    'image\n.jpg',
    '/custom/uploads',
    null,
  ])('rejects unsafe reference %j without filesystem access', async (path) => {
    const { inspector, fs } = setup();
    await expect(inspector.inspect(path)).resolves.toBe('unsafe');
    expect(fs.realpath).not.toHaveBeenCalled();
    expect(fs.lstat).not.toHaveBeenCalled();
  });

  it.each([
    'https://cdn.example/image.jpg',
    'S3://bucket/key',
    'gs://bucket/key',
    '//cdn.example/key',
    'ftp://server/file',
  ])(
    'reports remote indicator %s without filesystem or network access',
    async (path) => {
      const { inspector, fs } = setup();
      await expect(inspector.inspect(path)).resolves.toBe('external');
      expect(fs.realpath).not.toHaveBeenCalled();
      expect(fs.lstat).not.toHaveBeenCalled();
    },
  );

  it('does not treat absent file metadata as a missing physical file', async () => {
    const { inspector, fs } = setup();
    await expect(inspector.inspect('')).resolves.toBe('no-reference');
    expect(fs.lstat).not.toHaveBeenCalled();
  });

  it.each(['2026', '2026/image.jpg'])(
    'counts a nonexistent path component (%s) as missing',
    async (missing) => {
      const { inspector, fs } = setup();
      fs.lstat.mockImplementation(async (path) => {
        if (path === `/storage/uploads/${missing}`) throw error('ENOENT');
        return directory;
      });
      await expect(inspector.inspect('2026/image.jpg')).resolves.toBe(
        'missing',
      );
    },
  );

  it.each(['EACCES', 'EIO', 'ENOTDIR'])(
    'does not count %s as a missing file',
    async (code) => {
      const { inspector, fs } = setup();
      fs.lstat
        .mockResolvedValueOnce(directory)
        .mockRejectedValueOnce(error(code));
      await expect(inspector.inspect('image.jpg')).resolves.toBe('unavailable');
    },
  );

  it.each(['2026', '2026/image.jpg'])(
    'refuses symlink component %s without inspecting its target',
    async (link) => {
      const { inspector, fs } = setup();
      fs.lstat.mockImplementation(async (path) =>
        path === `/storage/uploads/${link}` ? symlink : directory,
      );
      await expect(inspector.inspect('2026/image.jpg')).resolves.toBe('unsafe');
      expect(fs.lstat).toHaveBeenLastCalledWith(`/storage/uploads/${link}`);
      expect(fs.realpath).toHaveBeenCalledExactlyOnceWith('/custom/uploads');
    },
  );

  it('rejects directories and special files as attachment files', async () => {
    const { inspector, fs } = setup();
    fs.lstat.mockResolvedValue(directory);
    await expect(inspector.inspect('folder')).resolves.toBe('unsafe');
    fs.lstat.mockResolvedValue({ ...file, isFile: () => false });
    await expect(inspector.inspect('device')).resolves.toBe('unsafe');
  });

  it.each([undefined, 's3://bucket/uploads', 'relative/uploads'])(
    'handles unavailable or nonlocal upload root %s',
    async (base) => {
      const fs = {
        realpath: vi.fn<MediaFileSystem['realpath']>(),
        lstat: vi.fn<MediaFileSystem['lstat']>(),
      };
      await expect(
        new MediaFileInspector(base, fs).inspect('image.jpg'),
      ).resolves.toBe('unavailable');
      expect(fs.realpath).not.toHaveBeenCalled();
    },
  );

  it('omits checks if the trusted base is absent or inaccessible', async () => {
    const { inspector, fs } = setup();
    fs.realpath.mockRejectedValue(error('ENOENT'));
    await expect(inspector.inspect('image.jpg')).resolves.toBe('unavailable');
    expect(fs.lstat).not.toHaveBeenCalled();
  });

  it('refuses a filesystem root as uploads', async () => {
    const { inspector, fs } = setup('/');
    fs.realpath.mockResolvedValue('/');
    await expect(inspector.inspect('etc/passwd')).resolves.toBe('unavailable');
    expect(fs.lstat).not.toHaveBeenCalled();
  });
});
