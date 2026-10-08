import { z } from 'zod';
import type { SiteComparison } from '../migration/site-comparison.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const strings = z.array(z.string());
const value = z.union([z.string(), count, z.boolean(), strings]);
const comparison = <T extends z.ZodType>(schema: T) =>
  z.object({
    status: z.enum(['equal', 'different', 'unknown']),
    source: schema.optional(),
    target: schema.optional(),
  });
const counts = comparison(count);
const booleans = comparison(z.boolean());
const text = comparison(z.string());
const fields = z.record(z.string(), comparison(value));
const changes = z.object({ differences: fields, unavailable: fields });
const distribution = z.array(
  z.object({ name: z.string(), source: count, target: count }),
);
const identity = z.object({
  path: z.string(),
  siteUrl: z.string(),
  homeUrl: z.string(),
  wordpressVersion: z.string(),
  multisite: z.boolean(),
  tablePrefix: z.string(),
});
const registrations = z.object({
  sourceOnly: strings,
  targetOnly: strings,
  shared: strings,
  changed: z.array(z.object({ name: z.string(), differences: fields })),
  unavailable: z.array(z.object({ name: z.string(), fields })),
  volumes: z.array(
    z.object({
      name: z.string(),
      source: count.optional(),
      target: count.optional(),
    }),
  ),
});
const table = z.object({
  name: z.string(),
  logicalName: z.string().optional(),
  rowCount: count.optional(),
  sizeBytes: count.optional(),
  engine: z.string().optional(),
  collation: z.string().optional(),
  usesWordPressPrefix: z.boolean(),
  likelyOwner: z.string().optional(),
  scope: z.enum(['site', 'network-or-main-site', 'unprefixed', 'unknown']),
  siteSpecific: z.boolean().optional(),
  siteId: count.optional(),
});
const membership = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unknown') }),
  z.object({
    status: z.literal('available'),
    siteCount: count,
    sitesWithUsers: count,
    minUserCount: count.optional(),
    maxUserCount: count.optional(),
  }),
]);

// Only the detail fields emitted by the comparison engine are public. This is
// response validation/projection, not a second set of comparison rules.
const details = z.object({
  component: z.string().optional(),
  source: z.boolean().optional(),
  target: z.boolean().optional(),
  name: z.string().optional(),
  fields: strings.optional(),
  names: strings.optional(),
  sourceName: z.string().optional(),
  targetName: z.string().optional(),
  sourceNames: strings.optional(),
  targetNames: strings.optional(),
  scope: z.string().optional(),
  likelyOwner: z.string().optional(),
  side: z.enum(['source', 'target']).optional(),
  sourceMin: count.optional(),
  sourceMax: count.optional(),
  targetMin: count.optional(),
  targetMax: count.optional(),
  analyzerCode: z.string().optional(),
  count: count.optional(),
  hostnameReferences: count.optional(),
  filesystemPathReferences: count.optional(),
});
const finding = z.object({
  code: z.string(),
  severity: z.enum(['info', 'warning', 'high', 'blocking']),
  category: z.enum([
    'environment',
    'content-type',
    'taxonomy',
    'database',
    'user',
    'media',
    'url',
  ]),
  message: z.string(),
  details: details.optional(),
});

/** Wire validation for the existing domain response; no sorting or reclassification. */
export const siteComparisonOutputSchema = z.object({
  source: identity,
  target: identity,
  compatibility: z.object({
    wordpressVersion: text,
    phpVersion: text,
    multisite: booleans,
  }),
  database: z.object({
    configuration: changes,
    metrics: z.object({
      tableCount: counts,
      coreTableCount: counts,
      customTableCount: counts,
      sizeBytes: counts,
      siteCount: counts,
      multisite: booleans,
      tablePrefix: text,
    }),
  }),
  contentTypes: registrations,
  taxonomies: registrations,
  customTables: z.object({
    sourceOnly: z.array(table),
    targetOnly: z.array(table),
    shared: z.array(
      z.object({
        source: table,
        target: table,
        matchingBasis: z.enum([
          'active-site-logical-name',
          'network-or-main-site-logical-name',
          'exact-name-and-scope',
        ]),
        metadata: changes,
      }),
    ),
    ambiguous: z.array(
      z.object({ sourceNames: strings, targetNames: strings }),
    ),
  }),
  users: z.object({
    idRangeStatus: z.enum(['overlap', 'disjoint', 'empty', 'unknown']),
    metrics: z.object({
      totalUsers: counts,
      minUserId: counts,
      maxUserId: counts,
      multisite: booleans,
      roleSiteId: counts,
      siteUserCount: counts,
      administratorCount: counts,
      usersWithoutRole: counts,
      duplicateEmailCount: counts,
      duplicateLoginCount: counts,
      usersWithLargeMetaSets: counts,
    }),
    roles: distribution,
    memberships: z.object({ source: membership, target: membership }),
  }),
  media: z.object({
    uploads: changes,
    metrics: z.object({
      totalAttachments: counts,
      minAttachmentId: counts,
      maxAttachmentId: counts,
      multisite: booleans,
      siteId: counts,
      missingAttachedFileMeta: counts,
      missingAttachmentMetadata: counts,
      missingLocalFiles: counts,
      checkedLocalFiles: counts,
      unattachedAttachments: counts,
      orphanedAttachments: counts,
      externalMediaCount: counts,
    }),
    mimeTypes: distribution,
    categories: distribution,
  }),
  urlReferences: z.object({
    targetHostsInSource: z.array(
      z.object({
        host: z.string(),
        status: z.enum(['observed', 'unknown', 'not-observed']),
        count: count.optional(),
      }),
    ),
    sourceOnlyObservedMediaHosts: z.array(
      z.object({ host: z.string(), referenceCount: count }),
    ),
    uploadHost: text,
    metrics: z.object({
      multisite: booleans,
      siteId: counts,
      totalReferences: counts,
      sourceUrlReferences: counts,
      externalUrlReferences: counts,
      httpReferences: counts,
      httpsReferences: counts,
      protocolRelativeReferences: counts,
      serializedValueReferences: counts,
      jsonValueReferences: counts,
      filesystemPathReferences: counts,
      developmentReferenceCount: counts,
      externalMediaReferences: counts,
      scannedValues: counts,
      unreportedHostReferences: counts,
      skippedSensitiveValues: counts,
      skippedOversizedValues: counts,
      skippedBinaryValues: counts,
      malformedUrlReferences: counts,
    }),
  }),
  conflicts: z.array(finding),
  warnings: z.array(finding.extend({ severity: z.enum(['info', 'warning']) })),
  summary: z.object({
    conflictCount: count,
    warningCount: count,
    blockingConflictCount: count,
  }),
} satisfies Record<keyof SiteComparison, z.ZodType>);
