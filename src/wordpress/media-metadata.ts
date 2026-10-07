import { z } from 'zod';

const count = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const optionalCount = count.nullish().transform((value) => value ?? undefined);
const optionalText = z.string().min(1).optional();

export const mediaMetadataSchema = z
  .object({
    totalAttachments: count,
    minAttachmentId: optionalCount,
    maxAttachmentId: optionalCount,
    mimeTypeCounts: z.record(z.string(), count),
    missingAttachedFileMeta: count,
    missingAttachmentMetadata: count,
    unattachedAttachments: count,
    orphanedAttachments: count,
    externalMediaCount: count,
    uploadBaseDir: optionalText,
    uploadBaseUrl: optionalText,
    usesYearMonthFolders: z.boolean().optional(),
    multisite: z.boolean(),
    siteId: count.pipe(z.number().positive()),
  })
  .superRefine((value, ctx) => {
    const invalid = (message: string) =>
      ctx.addIssue({ code: 'custom', message });
    if (value.totalAttachments === 0) {
      if (
        value.minAttachmentId !== undefined ||
        value.maxAttachmentId !== undefined
      )
        invalid('Empty attachments must have no ID range');
    } else if (
      value.minAttachmentId === undefined ||
      value.maxAttachmentId === undefined ||
      value.minAttachmentId > value.maxAttachmentId
    ) {
      invalid('Non-empty attachments must have an ordered ID range');
    }
    if (
      Object.values(value.mimeTypeCounts).reduce((sum, n) => sum + n, 0) !==
      value.totalAttachments
    )
      invalid('MIME counts must sum to the attachment total');
    for (const n of [
      value.missingAttachedFileMeta,
      value.missingAttachmentMetadata,
      value.unattachedAttachments,
      value.orphanedAttachments,
      value.externalMediaCount,
    ]) {
      if (n > value.totalAttachments) invalid('Attachment counts exceed total');
    }
    if (
      value.unattachedAttachments + value.orphanedAttachments >
      value.totalAttachments
    )
      invalid('Parent categories cannot overlap');
  });

export type WpMediaMetadata = z.infer<typeof mediaMetadataSchema>;

// Bounds keep even heavily JSON-escaped paths below the process output limit.
export const attachmentFilePageSize = 100;
export const attachmentFilePathLimit = 1024;
export const attachmentFileReferencesSchema = z
  .array(
    z.object({
      id: count,
      // Empty means absent/empty metadata; null means an oversized value was withheld.
      attachedFile: z.string().max(attachmentFilePathLimit).nullable(),
    }),
  )
  .max(attachmentFilePageSize);

export type AttachmentFileReference = z.infer<
  typeof attachmentFileReferencesSchema
>[number];
