import { MediaFileInspector } from '../wordpress/media-file-inspector.js';
import { attachmentFilePageSize } from '../wordpress/media-metadata.js';
import {
  WpCliOutputError,
  type WpCliClient,
} from '../wordpress/wp-cli-client.js';

export interface MediaAnalysisWarning {
  code: string;
  message: string;
  count?: number;
}

export interface MediaAnalysis {
  totalAttachments: number;
  minAttachmentId?: number;
  maxAttachmentId?: number;
  mimeTypeCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
  missingAttachedFileMeta: number;
  missingAttachmentMetadata: number;
  /** Only validated local references with a definitive absent-file result. */
  missingLocalFiles?: number;
  /** References conclusively found present or missing during the optional check. */
  checkedLocalFiles?: number;
  unattachedAttachments: number;
  /** Nonzero post_parent points to no existing post in the active site's table. */
  orphanedAttachments: number;
  uploadBaseDir?: string;
  uploadBaseUrl?: string;
  usesYearMonthFolders?: boolean;
  /** Explicit remote URI indicators in _wp_attached_file, not proof of offloading. */
  externalMediaCount: number;
  multisite: boolean;
  siteId: number;
  warnings: MediaAnalysisWarning[];
}

export interface MediaAnalysisOptions {
  /** Opt in to bounded reference pages and per-path filesystem metadata checks. */
  checkLocalFiles?: boolean;
}

export class MediaAnalyzer {
  constructor(
    private readonly client: Pick<
      WpCliClient,
      'getMediaMetadata' | 'getAttachmentFileReferences'
    >,
    private readonly createFileInspector: (
      baseDir: string | undefined,
    ) => Pick<MediaFileInspector, 'inspect'> = (baseDir) =>
      new MediaFileInspector(baseDir),
  ) {}

  async analyze(options: MediaAnalysisOptions = {}): Promise<MediaAnalysis> {
    const metadata = await this.client.getMediaMetadata();
    const warnings: MediaAnalysisWarning[] = [];
    const warn = (code: string, message: string, count: number) => {
      if (count > 0) warnings.push({ code, message, count });
    };
    warn(
      'MISSING_ATTACHED_FILE_META',
      'Attachments lack a non-empty primary _wp_attached_file value.',
      metadata.missingAttachedFileMeta,
    );
    warn(
      'MISSING_ATTACHMENT_METADATA',
      'Attachments lack non-empty _wp_attachment_metadata; some media types may legitimately omit it.',
      metadata.missingAttachmentMetadata,
    );
    warn(
      'ORPHANED_ATTACHMENTS',
      'Attachments reference parent posts that no longer exist.',
      metadata.orphanedAttachments,
    );
    warn(
      'EXTERNAL_MEDIA_REFERENCES',
      'Attachment file metadata contains remote URI indicators; remote availability and offload ownership were not verified.',
      metadata.externalMediaCount,
    );
    if (
      metadata.uploadBaseDir === undefined ||
      metadata.uploadBaseUrl === undefined
    ) {
      warnings.push({
        code: 'UPLOAD_CONFIGURATION_UNAVAILABLE',
        message:
          'Some upload configuration is unavailable from the WordPress runtime.',
      });
    }

    const mimeTypeCounts = Object.fromEntries(
      Object.entries(metadata.mimeTypeCounts).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    );
    const categories = new Map<string, number>();
    for (const [mime, count] of Object.entries(mimeTypeCounts)) {
      const category =
        /^(image|audio|video|text|application)\//i
          .exec(mime)?.[1]
          ?.toLowerCase() ?? 'other';
      categories.set(category, (categories.get(category) ?? 0) + count);
    }
    const result: MediaAnalysis = {
      totalAttachments: metadata.totalAttachments,
      ...(metadata.minAttachmentId === undefined
        ? {}
        : { minAttachmentId: metadata.minAttachmentId }),
      ...(metadata.maxAttachmentId === undefined
        ? {}
        : { maxAttachmentId: metadata.maxAttachmentId }),
      mimeTypeCounts,
      categoryCounts: Object.fromEntries(
        [...categories].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
      missingAttachedFileMeta: metadata.missingAttachedFileMeta,
      missingAttachmentMetadata: metadata.missingAttachmentMetadata,
      unattachedAttachments: metadata.unattachedAttachments,
      orphanedAttachments: metadata.orphanedAttachments,
      externalMediaCount: metadata.externalMediaCount,
      multisite: metadata.multisite,
      siteId: metadata.siteId,
      ...(metadata.uploadBaseDir === undefined
        ? {}
        : { uploadBaseDir: metadata.uploadBaseDir }),
      ...(metadata.uploadBaseUrl === undefined
        ? {}
        : { uploadBaseUrl: metadata.uploadBaseUrl }),
      ...(metadata.usesYearMonthFolders === undefined
        ? {}
        : { usesYearMonthFolders: metadata.usesYearMonthFolders }),
      warnings,
    };
    if (!options.checkLocalFiles) {
      warnings.push({
        code: 'LOCAL_FILES_NOT_CHECKED',
        message:
          'Physical file checks were not requested; missingLocalFiles is unavailable.',
      });
    } else {
      const inspector = this.createFileInspector(metadata.uploadBaseDir);
      let afterId = -1;
      let visited = 0;
      let missing = 0;
      let checked = 0;
      let unsafe = 0;
      let unavailable = 0;
      if (metadata.maxAttachmentId !== undefined) {
        while (true) {
          const page = await this.client.getAttachmentFileReferences(
            afterId,
            metadata.maxAttachmentId,
          );
          for (const row of page) {
            const status = await inspector.inspect(row.attachedFile);
            if (status === 'missing') missing++;
            if (status === 'missing' || status === 'present') checked++;
            if (status === 'unsafe') unsafe++;
            if (status === 'unavailable') unavailable++;
          }
          visited += page.length;
          const last = page.at(-1);
          if (
            page.length < attachmentFilePageSize ||
            last?.id === metadata.maxAttachmentId
          )
            break;
          // The adapter validates ordering; also guard against a broken injected client.
          if (!last || last.id <= afterId)
            throw new WpCliOutputError('eval (attachment file references)');
          afterId = last.id;
        }
      }
      result.checkedLocalFiles = checked;
      // Omit a wholly unavailable check; never substitute zero for a failed check.
      if (
        checked > 0 ||
        (unsafe === 0 &&
          unavailable === 0 &&
          visited === metadata.totalAttachments)
      )
        result.missingLocalFiles = missing;
      warn(
        'MISSING_LOCAL_FILES',
        'Validated attachment paths have no local file. This can be intentional for offloaded media.',
        missing,
      );
      warn(
        'UNSAFE_ATTACHMENT_PATHS',
        'References outside uploads, symlinks, invalid or oversized paths were skipped.',
        unsafe,
      );
      warn(
        'LOCAL_FILE_CHECKS_UNAVAILABLE',
        'Local file checks were inconclusive because upload storage or filesystem metadata was unavailable.',
        unavailable,
      );
      if (visited !== metadata.totalAttachments) {
        warnings.push({
          code: 'ATTACHMENTS_CHANGED_DURING_ANALYSIS',
          message:
            'Attachment counts changed between the summary and file inspection; retry on a stable installation.',
        });
      }
    }
    warnings.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    return result;
  }
}
