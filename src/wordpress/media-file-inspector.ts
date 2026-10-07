import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, parse } from 'node:path';

interface FileStatus {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface MediaFileSystem {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<FileStatus>;
}

export type MediaFileStatus =
  | 'present'
  | 'missing'
  | 'external'
  | 'unsafe'
  | 'unavailable'
  | 'no-reference';

function outside(path: string): boolean {
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}

/** Checks only attachment references under a trusted configured uploads directory. */
export class MediaFileInspector {
  #root: Promise<string | undefined> | undefined;

  constructor(
    private readonly uploadBaseDir: string | undefined,
    private readonly fs: MediaFileSystem = { realpath, lstat },
  ) {}

  async inspect(attachedFile: string | null): Promise<MediaFileStatus> {
    if (attachedFile === '') return 'no-reference';
    if (attachedFile === null) return 'unsafe';
    if (/^(?:(?:https?|ftp|s3|gs):\/\/|\/\/)/i.test(attachedFile))
      return 'external';
    if (
      [...attachedFile].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      ) ||
      attachedFile.split(/[\\/]/).includes('..') ||
      (sep === '/' && attachedFile.includes('\\')) ||
      // Stream wrappers and drive paths from another OS are not local references.
      (/^[a-z][a-z\d+.-]*:/i.test(attachedFile) && !isAbsolute(attachedFile))
    )
      return 'unsafe';

    const base = this.uploadBaseDir;
    if (!base || !isAbsolute(base) || base.includes('\0')) return 'unavailable';
    const candidate = resolve(base, attachedFile);
    const subpath = relative(resolve(base), candidate);
    if (!subpath || outside(subpath)) return 'unsafe';

    // Resolve only the trusted base. Never realpath an untrusted postmeta path.
    this.#root ??= this.resolveRoot(base);
    const root = await this.#root;
    if (root === undefined) return 'unavailable';

    let current = root;
    const segments = subpath.split(sep);
    for (let index = 0; index < segments.length; index++) {
      current = resolve(current, segments[index]!);
      let status: FileStatus;
      try {
        status = await this.fs.lstat(current);
      } catch (error) {
        // Permissions, I/O errors, and unsupported storage must not imply absence.
        return (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'missing'
          : 'unavailable';
      }
      // Reject even inward-pointing symlinks: no metadata-controlled link is followed.
      if (status.isSymbolicLink()) return 'unsafe';
      if (index === segments.length - 1)
        return status.isFile() ? 'present' : 'unsafe';
      if (!status.isDirectory()) return 'unsafe';
    }
    return 'unsafe';
  }

  private async resolveRoot(base: string): Promise<string | undefined> {
    try {
      const root = await this.fs.realpath(base);
      if (!isAbsolute(root) || root === parse(root).root) return undefined;
      const status = await this.fs.lstat(root);
      return status.isDirectory() && !status.isSymbolicLink()
        ? root
        : undefined;
    } catch {
      return undefined;
    }
  }
}
