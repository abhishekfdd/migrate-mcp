import { isIP } from 'node:net';
import { z } from 'zod';

const count = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const host = z
  .string()
  .min(1)
  .max(253)
  .refine(
    (value) =>
      value === value.toLowerCase() &&
      (isIP(value) !== 0 ||
        (!/^[0-9.]+$/.test(value) &&
          value
            .split('.')
            .every((label) =>
              /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
            ))),
  );
const hosts = z
  .record(host, count)
  .refine((value) => Object.keys(value).length <= 1000);
const publicUrl = z
  .string()
  .url()
  .regex(/^https?:\/\//)
  .refine((value) => {
    try {
      const url = new URL(value);
      return !url.username && !url.password && !url.search && !url.hash;
    } catch {
      return false;
    }
  })
  .optional();

export const urlReferenceMetadataSchema = z
  .object({
    siteUrl: publicUrl,
    homeUrl: publicUrl,
    uploadBaseUrl: publicUrl,
    multisite: z.boolean(),
    siteId: count.pipe(z.number().positive()),
    totalReferences: count,
    hostCounts: hosts,
    sourceUrlReferences: count,
    externalUrlReferences: count,
    httpReferences: count,
    httpsReferences: count,
    protocolRelativeReferences: count,
    siteUrlReferences: count,
    homeUrlReferences: count,
    uploadUrlReferences: count,
    alternateSourceHosts: z.array(host).max(2),
    externalMediaHostCounts: hosts,
    externalMediaReferences: count,
    serializedValueReferences: count,
    jsonValueReferences: count,
    filesystemPathReferences: count,
    developmentReferenceCount: count,
    malformedUrlReferences: count,
    unreportedHostReferences: count,
    scannedValues: count,
    skippedSensitiveValues: count,
    skippedOversizedValues: count,
    skippedBinaryValues: count,
    locations: z
      .array(
        z.object({
          source: z
            .string()
            .max(256)
            .regex(/^[A-Za-z0-9_$]+\.[A-Za-z0-9_]+$/),
          referenceCount: count,
        }),
      )
      .length(7),
  })
  .superRefine((value, ctx) => {
    const invalid = (message: string) =>
      ctx.addIssue({ code: 'custom', message });
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
    if (
      value.httpReferences +
        value.httpsReferences +
        value.protocolRelativeReferences !==
        value.totalReferences ||
      value.sourceUrlReferences + value.externalUrlReferences !==
        value.totalReferences ||
      sum(Object.values(value.hostCounts)) + value.unreportedHostReferences !==
        value.totalReferences ||
      sum(value.locations.map((location) => location.referenceCount)) !==
        value.totalReferences
    )
      invalid('Inconsistent reference totals');
    if (
      new Set(value.locations.map((location) => location.source)).size !==
        value.locations.length ||
      new Set(value.alternateSourceHosts).size !==
        value.alternateSourceHosts.length
    )
      invalid('Duplicate summary entries');
    for (const n of [
      value.siteUrlReferences,
      value.homeUrlReferences,
      value.uploadUrlReferences,
      value.serializedValueReferences,
      value.jsonValueReferences,
      value.developmentReferenceCount,
    ]) {
      if (n > value.totalReferences) invalid('Subset exceeds reference total');
    }
    if (
      value.externalMediaReferences > value.externalUrlReferences ||
      sum(Object.values(value.externalMediaHostCounts)) >
        value.externalMediaReferences
    )
      invalid('Invalid external media counts');
    for (const [key, n] of Object.entries(value.externalMediaHostCounts)) {
      if (n > (value.hostCounts[key] ?? 0))
        invalid('Media host absent from host summary');
    }
  });

export type WpUrlReferenceMetadata = z.infer<typeof urlReferenceMetadataSchema>;
