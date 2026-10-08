import type { ValueComparison } from '../../src/migration/comparison-model.js';
import type { SiteComparison } from '../../src/migration/site-comparison.js';

const zeroCounts = <K extends string>(
  ...keys: K[]
): Record<K, ValueComparison> =>
  Object.fromEntries(
    keys.map((key) => [key, { status: 'equal', source: 0, target: 0 }]),
  ) as Record<K, ValueComparison>;
const equal = <T>(value: T) => ({
  status: 'equal' as const,
  source: value,
  target: value,
});

export function identicalComparison(): SiteComparison {
  const identity = {
    siteUrl: 'https://example.com/',
    homeUrl: 'https://example.com/',
    wordpressVersion: '6.8',
    multisite: false,
    tablePrefix: 'wp_',
  };
  const registrations = () => ({
    sourceOnly: [],
    targetOnly: [],
    shared: [],
    changed: [],
    unavailable: [],
    volumes: [],
  });
  return {
    source: { path: '/source', ...identity },
    target: { path: '/target', ...identity },
    compatibility: {
      wordpressVersion: equal('6.8'),
      phpVersion: equal('8.3'),
      multisite: equal(false),
    },
    database: {
      configuration: { differences: {}, unavailable: {} },
      metrics: {
        ...zeroCounts(
          'tableCount',
          'coreTableCount',
          'customTableCount',
          'sizeBytes',
          'siteCount',
        ),
        multisite: equal(false),
        tablePrefix: equal('wp_'),
      },
    },
    contentTypes: registrations(),
    taxonomies: registrations(),
    customTables: { sourceOnly: [], targetOnly: [], shared: [], ambiguous: [] },
    users: {
      idRangeStatus: 'empty',
      metrics: {
        ...zeroCounts(
          'totalUsers',
          'minUserId',
          'maxUserId',
          'roleSiteId',
          'siteUserCount',
          'administratorCount',
          'usersWithoutRole',
          'duplicateEmailCount',
          'duplicateLoginCount',
          'usersWithLargeMetaSets',
        ),
        minUserId: { status: 'unknown' },
        maxUserId: { status: 'unknown' },
        multisite: equal(false),
      },
      roles: [],
      memberships: {
        source: { status: 'unknown' },
        target: { status: 'unknown' },
      },
    },
    media: {
      uploads: { differences: {}, unavailable: {} },
      metrics: {
        ...zeroCounts(
          'totalAttachments',
          'minAttachmentId',
          'maxAttachmentId',
          'siteId',
          'missingAttachedFileMeta',
          'missingAttachmentMetadata',
          'missingLocalFiles',
          'checkedLocalFiles',
          'unattachedAttachments',
          'orphanedAttachments',
          'externalMediaCount',
        ),
        multisite: equal(false),
        minAttachmentId: { status: 'unknown' },
        maxAttachmentId: { status: 'unknown' },
        missingLocalFiles: { status: 'unknown' },
        checkedLocalFiles: { status: 'unknown' },
      },
      mimeTypes: [],
      categories: [],
    },
    urlReferences: {
      targetHostsInSource: [{ host: 'example.com', status: 'not-observed' }],
      sourceOnlyObservedMediaHosts: [],
      uploadHost: { status: 'unknown' },
      metrics: {
        ...zeroCounts(
          'siteId',
          'totalReferences',
          'sourceUrlReferences',
          'externalUrlReferences',
          'httpReferences',
          'httpsReferences',
          'protocolRelativeReferences',
          'serializedValueReferences',
          'jsonValueReferences',
          'filesystemPathReferences',
          'developmentReferenceCount',
          'externalMediaReferences',
          'scannedValues',
          'unreportedHostReferences',
          'skippedSensitiveValues',
          'skippedOversizedValues',
          'skippedBinaryValues',
          'malformedUrlReferences',
        ),
        multisite: equal(false),
      },
    },
    conflicts: [],
    warnings: [],
    summary: { conflictCount: 0, warningCount: 0, blockingConflictCount: 0 },
  };
}

export function comparisonWithRisks(): SiteComparison {
  const result = identicalComparison();
  result.target.multisite = true;
  result.compatibility.multisite = {
    status: 'different',
    source: false,
    target: true,
  };
  result.contentTypes = {
    sourceOnly: ['movie'],
    targetOnly: ['portfolio'],
    shared: ['article'],
    changed: [
      {
        name: 'article',
        differences: {
          supports: {
            status: 'different',
            source: ['editor', 'title'],
            target: ['title'],
          },
          rewriteSlug: {
            status: 'different',
            source: 'news',
            target: 'articles',
          },
        },
      },
    ],
    unavailable: [
      {
        name: 'article',
        fields: { restBase: { status: 'unknown', target: 'articles' } },
      },
    ],
    volumes: [
      { name: 'article', source: 20, target: 4 },
      { name: 'movie', source: 10 },
      { name: 'portfolio', target: 2 },
    ],
  };
  result.taxonomies = {
    sourceOnly: ['genre'],
    targetOnly: ['topic'],
    shared: [],
    changed: [],
    unavailable: [],
    volumes: [
      { name: 'genre', source: 3 },
      { name: 'topic', target: 1 },
    ],
  };
  const table = {
    name: 'wp_events',
    logicalName: 'events',
    scope: 'site' as const,
    usesWordPressPrefix: true,
    rowCount: 42,
    sizeBytes: 2048,
    siteSpecific: true,
    siteId: 1,
  };
  result.customTables = {
    sourceOnly: [
      {
        name: 'wp_metrics',
        logicalName: 'metrics',
        scope: 'site',
        usesWordPressPrefix: true,
      },
    ],
    targetOnly: [
      { name: 'external', scope: 'unprefixed', usesWordPressPrefix: false },
    ],
    shared: [
      {
        source: table,
        target: { ...table, name: 'target_events', rowCount: 2 },
        matchingBasis: 'active-site-logical-name',
        metadata: {
          differences: {},
          unavailable: { engine: { status: 'unknown' } },
        },
      },
    ],
    ambiguous: [{ sourceNames: ['wp_a', 'wp_b'], targetNames: ['target_a'] }],
  };
  result.users.idRangeStatus = 'overlap';
  result.users.metrics.totalUsers = {
    status: 'different',
    source: 10,
    target: 4,
  };
  result.users.metrics.minUserId = equal(1);
  result.users.metrics.maxUserId = {
    status: 'different',
    source: 10,
    target: 4,
  };
  result.users.roles = [{ name: 'administrator', source: 1, target: 2 }];
  result.users.memberships.target = {
    status: 'available',
    siteCount: 2,
    sitesWithUsers: 1,
    minUserCount: 0,
    maxUserCount: 4,
  };
  result.media.uploads.differences.uploadBaseUrl = {
    status: 'different',
    source: 'https://old.example/uploads',
    target: 'https://example.com/uploads',
  };
  result.media.mimeTypes = [{ name: 'image/jpeg', source: 10, target: 2 }];
  result.media.categories = [{ name: 'image', source: 10, target: 2 }];
  result.urlReferences.targetHostsInSource = [
    { host: 'example.com', status: 'observed', count: 7 },
  ];
  result.urlReferences.sourceOnlyObservedMediaHosts = [
    { host: 'cdn.old.example', referenceCount: 6 },
  ];
  result.conflicts = [
    {
      code: 'MULTISITE_MODE_MISMATCH',
      severity: 'blocking',
      category: 'environment',
      message: 'Direct migration requires topology handling.',
      details: { source: false, target: true },
    },
    {
      code: 'USER_ID_RANGE_OVERLAP',
      severity: 'high',
      category: 'user',
      message: 'Ranges overlap.',
      details: { sourceMin: 1, sourceMax: 10, targetMin: 1, targetMax: 4 },
    },
  ];
  result.warnings = [
    {
      code: 'CONTENT_TYPE_CONFIGURATION_MISMATCH',
      severity: 'warning',
      category: 'content-type',
      message: 'Settings differ.',
      details: { name: 'article', fields: ['rewriteSlug', 'supports'] },
    },
    {
      code: 'ANALYZER_WARNING',
      severity: 'warning',
      category: 'media',
      message: 'Physical files were not checked.',
      details: { side: 'source', analyzerCode: 'LOCAL_FILES_NOT_CHECKED' },
    },
    {
      code: 'UPLOAD_HOST_MISMATCH',
      severity: 'info',
      category: 'url',
      message: 'Upload hostnames differ.',
    },
  ];
  result.summary = {
    conflictCount: 2,
    warningCount: 3,
    blockingConflictCount: 1,
  };
  return result;
}
