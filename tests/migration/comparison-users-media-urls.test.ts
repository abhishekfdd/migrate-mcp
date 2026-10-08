import { describe, expect, it } from 'vitest';
import { setup } from '../fixtures/site-comparison.js';

describe('user comparison', () => {
  it.each([
    { source: [1, 25000], target: [1, 12000], status: 'overlap' },
    { source: [1, 10], target: [10, 20], status: 'overlap' },
    { source: [1, 9], target: [10, 20], status: 'disjoint' },
    { source: [10, 20], target: [1, 9], status: 'disjoint' },
  ])(
    'classifies ranges $source and $target as $status',
    async ({ source, target, status }) => {
      const test = setup();
      Object.assign(test.source.users, {
        totalUsers: 2,
        minUserId: source[0],
        maxUserId: source[1],
      });
      Object.assign(test.target.users, {
        totalUsers: 2,
        minUserId: target[0],
        maxUserId: target[1],
      });
      const result = await test.compare();
      expect(result.users.idRangeStatus).toBe(status);
      expect(
        result.conflicts.filter(({ code }) => code === 'USER_ID_RANGE_OVERLAP'),
      ).toHaveLength(status === 'overlap' ? 1 : 0);
      if (status === 'overlap')
        expect(result.conflicts[0]).toMatchObject({
          severity: 'high',
          details: {
            sourceMin: source[0],
            sourceMax: source[1],
            targetMin: target[0],
            targetMax: target[1],
          },
        });
    },
  );

  it('keeps incomplete nonempty ranges unknown and empty installations collision-free', async () => {
    const test = setup();
    test.source.users.totalUsers = 2;
    test.target.users.totalUsers = 1;
    expect((await test.compare()).users.idRangeStatus).toBe('unknown');
    test.target.users.totalUsers = 0;
    const result = await test.compare();
    expect(result.users.idRangeStatus).toBe('empty');
    expect(result.conflicts).toEqual([]);
  });

  it('compares roles and membership characteristics without matching users or site IDs', async () => {
    const test = setup();
    Object.assign(test.source.users, {
      multisite: true,
      roleSiteId: 3,
      totalUsers: 20,
      roleCounts: { subscriber: 8, editor: 2, constructor: 1 },
      usersWithoutRole: 10,
      duplicateEmailCount: 3,
      duplicateLoginCount: 1,
      siteMemberships: [
        { siteId: 3, userCount: 0 },
        { siteId: 7, userCount: 20 },
      ],
      warnings: [
        {
          code: 'DUPLICATE_EMAILS',
          message: 'Duplicate email indicators.',
          count: 3,
        },
      ],
    });
    Object.assign(test.target.users, {
      roleCounts: { editor: 5 },
      siteMemberships: [{ siteId: 100, userCount: 5 }],
    });
    const result = await test.compare();
    expect(result.users.roles).toEqual([
      { name: 'constructor', source: 1, target: 0 },
      { name: 'editor', source: 2, target: 5 },
      { name: 'subscriber', source: 8, target: 0 },
    ]);
    expect(result.users.memberships.source).toEqual({
      status: 'available',
      siteCount: 2,
      sitesWithUsers: 1,
      minUserCount: 0,
      maxUserCount: 20,
    });
    expect(result.users.metrics.duplicateEmailCount.source).toBe(3);
    expect(result.users.metrics.duplicateLoginCount.source).toBe(1);
    expect(result.users.metrics.usersWithoutRole.source).toBe(10);
    expect(result.users.metrics.roleSiteId.source).toBe(3);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'ANALYZER_WARNING',
        category: 'user',
        details: { side: 'source', analyzerCode: 'DUPLICATE_EMAILS', count: 3 },
      }),
    );
    expect(result.users).not.toHaveProperty('siteMemberships');
  });
});

describe('media comparison', () => {
  it('compares upload settings, volume, anomalies and MIME summaries', async () => {
    const test = setup();
    Object.assign(test.source.media, {
      totalAttachments: 10,
      mimeTypeCounts: { 'image/png': 7, 'application/pdf': 3 },
      categoryCounts: { image: 7, application: 3 },
      missingAttachmentMetadata: 2,
      missingLocalFiles: 3,
      checkedLocalFiles: 10,
      externalMediaCount: 4,
      orphanedAttachments: 1,
      unattachedAttachments: 2,
      warnings: [
        {
          code: 'MISSING_LOCAL_FILES',
          message: 'Local references are absent.',
          count: 3,
        },
      ],
    });
    Object.assign(test.target.media, {
      uploadBaseDir: '/custom/uploads',
      uploadBaseUrl: 'https://target.example/uploads',
      usesYearMonthFolders: false,
    });
    const result = await test.compare();
    expect(Object.keys(result.media.uploads.differences)).toEqual([
      'uploadBaseDir',
      'uploadBaseUrl',
      'usesYearMonthFolders',
    ]);
    expect(result.media.metrics.totalAttachments.source).toBe(10);
    expect(result.media.metrics.missingLocalFiles).toEqual({
      status: 'unknown',
      source: 3,
    });
    expect(result.media.metrics.externalMediaCount.source).toBe(4);
    expect(result.media.metrics.orphanedAttachments.source).toBe(1);
    expect(result.media.mimeTypes).toEqual([
      { name: 'application/pdf', source: 3, target: 0 },
      { name: 'image/png', source: 7, target: 0 },
    ]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'UPLOAD_CONFIGURATION_MISMATCH',
        severity: 'warning',
      }),
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'ANALYZER_WARNING',
        category: 'media',
        details: {
          side: 'source',
          analyzerCode: 'MISSING_LOCAL_FILES',
          count: 3,
        },
      }),
    );
  });

  it('does not turn absent upload or file-check metadata into differences or zero counts', async () => {
    const test = setup();
    delete test.source.media.uploadBaseDir;
    delete test.source.media.usesYearMonthFolders;
    const result = await test.compare();
    expect(result.media.uploads.differences).toEqual({});
    expect(result.media.uploads.unavailable.uploadBaseDir).toEqual({
      status: 'unknown',
      target: '/uploads',
    });
    expect(result.media.metrics.missingLocalFiles).toEqual({
      status: 'unknown',
    });
    expect(result.conflicts).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe('URL/reference comparison', () => {
  it('surfaces source dependencies, target-host observations, development hints and media hosts', async () => {
    const test = setup();
    test.target.site.siteUrl = 'https://target.example.com/wp';
    test.target.site.homeUrl = 'https://www.target.example.com';
    Object.assign(test.source.urls, {
      totalReferences: 40,
      sourceUrlReferences: 20,
      filesystemPathReferences: 2,
      developmentReferenceCount: 3,
      serializedValueReferences: 5,
      jsonValueReferences: 6,
      hostCounts: { 'target.example.com': 4 },
      externalMediaHostCounts: { 'cdn.source.example': 7, 'shared.example': 3 },
    });
    Object.assign(test.target.urls, {
      externalMediaHostCounts: { 'shared.example': 8 },
      uploadBaseUrl: 'https://target.example.com/uploads',
    });
    const result = await test.compare();
    expect(result.urlReferences.targetHostsInSource).toEqual([
      { host: 'target.example.com', status: 'observed', count: 4 },
      { host: 'www.target.example.com', status: 'not-observed' },
    ]);
    expect(result.urlReferences.sourceOnlyObservedMediaHosts).toEqual([
      { host: 'cdn.source.example', referenceCount: 7 },
    ]);
    expect(result.urlReferences.uploadHost.status).toBe('different');
    expect(result.urlReferences.metrics.serializedValueReferences.source).toBe(
      5,
    );
    expect(result.urlReferences.metrics.jsonValueReferences.source).toBe(6);
    expect(result.warnings.map(({ code }) => code)).toEqual([
      'DEVELOPMENT_URL_REFERENCES',
      'SOURCE_ENVIRONMENT_REFERENCES_FOUND',
      'UPLOAD_HOST_MISMATCH',
    ]);
    expect(
      result.warnings.find(
        ({ code }) => code === 'SOURCE_ENVIRONMENT_REFERENCES_FOUND',
      )?.details,
    ).toEqual({ hostnameReferences: 20, filesystemPathReferences: 2 });
  });

  it('preserves scan limits, warnings, unknown host counts and unavailable configuration', async () => {
    const test = setup();
    test.source.urls.unreportedHostReferences = 10;
    test.source.urls.skippedOversizedValues = 2;
    test.source.urls.warnings = [
      {
        code: 'HOST_SUMMARY_LIMIT',
        message: 'Host counts are incomplete.',
        count: 10,
      },
    ];
    delete test.source.urls.uploadBaseUrl;
    const result = await test.compare();
    expect(result.urlReferences.targetHostsInSource).toEqual([
      { host: 'example.com', status: 'unknown' },
    ]);
    expect(result.urlReferences.uploadHost).toEqual({
      status: 'unknown',
      target: 'example.com',
    });
    expect(result.urlReferences.metrics.skippedOversizedValues.source).toBe(2);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'ANALYZER_WARNING',
        category: 'url',
        details: {
          side: 'source',
          analyzerCode: 'HOST_SUMMARY_LIMIT',
          count: 10,
        },
      }),
    );
  });

  it('deduplicates configured target hosts and reports target development warnings', async () => {
    const test = setup();
    test.target.site.siteUrl = 'https://EXAMPLE.COM./wp';
    test.target.urls.developmentReferenceCount = 1;
    const result = await test.compare();
    expect(result.urlReferences.targetHostsInSource).toHaveLength(1);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'DEVELOPMENT_URL_REFERENCES',
        details: { side: 'target', count: 1 },
      }),
    );
  });
});
