import { describe, expect, it } from 'vitest';
import { WpCliOutputError } from '../../src/wordpress/wp-cli-client.js';
import {
  calls,
  contentType,
  input,
  setup,
  table,
  taxonomy,
} from '../fixtures/site-comparison.js';

describe('SiteComparisonService', () => {
  it('compares identical empty installations without inventing conflicts', async () => {
    const { compare, left, right, factory } = setup();
    const result = await compare();
    expect(result.summary).toEqual({
      conflictCount: 0,
      warningCount: 0,
      blockingConflictCount: 0,
    });
    expect(result.compatibility.wordpressVersion).toEqual({
      status: 'equal',
      source: '6.8',
      target: '6.8',
    });
    expect(result.source).toEqual({
      path: '/source',
      siteUrl: 'https://example.com/',
      homeUrl: 'https://example.com/',
      wordpressVersion: '6.8',
      multisite: false,
      tablePrefix: 'wp_',
    });
    expect(result.target.path).toBe('/target');
    expect(result.users.idRangeStatus).toBe('empty');
    expect(result.contentTypes.shared).toEqual(['post']);
    expect(factory.mock.calls).toEqual([['/source'], ['/target']]);
    for (const call of [...calls(left), ...calls(right)])
      expect(call).toHaveBeenCalledExactlyOnceWith();
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('reports runtime differences without claiming version incompatibility', async () => {
    const test = setup();
    test.target.site.wordpressVersion = '6.9';
    test.target.site.phpVersion = '8.4.0';
    const result = await test.compare();
    expect(result.compatibility.wordpressVersion.status).toBe('different');
    expect(result.compatibility.phpVersion.status).toBe('different');
    expect(result.conflicts).toEqual([]);
    expect(
      result.warnings.map(({ code, details }) => [code, details?.component]),
    ).toEqual([
      ['VERSION_DIFFERENCE', 'phpVersion'],
      ['VERSION_DIFFERENCE', 'wordpressVersion'],
    ]);
  });

  it('blocks direct migration between different multisite modes', async () => {
    const test = setup();
    test.target.site.isMultisite = true;
    const result = await test.compare();
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({
        code: 'MULTISITE_MODE_MISMATCH',
        severity: 'blocking',
      }),
    );
    expect(result.summary.blockingConflictCount).toBe(1);
  });

  it('compares database defaults separately from database volume', async () => {
    const test = setup();
    Object.assign(test.target.database, {
      charset: 'latin1',
      collation: 'latin1_swedish_ci',
      tableCount: 50,
      sizeBytes: 200,
      siteCount: 3,
    });
    const result = await test.compare();
    expect(Object.keys(result.database.configuration.differences)).toEqual([
      'charset',
      'collation',
    ]);
    expect(result.database.metrics.sizeBytes).toEqual({
      status: 'unknown',
      target: 200,
    });
    expect(result.database.metrics.tableCount).toEqual({
      status: 'different',
      source: 12,
      target: 50,
    });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'DATABASE_CONFIGURATION_MISMATCH',
        severity: 'warning',
      }),
    );
    expect(result.conflicts).toEqual([]);
  });

  it('returns missing registrations, shared keys, configuration changes and volumes', async () => {
    const test = setup();
    test.source.contentTypes.push(contentType('movie'));
    test.target.contentTypes.push(contentType('portfolio'));
    Object.assign(test.source.contentTypes[0]!, {
      rewriteSlug: 'news',
      postCount: 20,
    });
    Object.assign(test.target.contentTypes[0]!, {
      rewriteSlug: 'articles',
      hierarchical: true,
      postCount: 2,
    });
    test.source.taxonomies.push(taxonomy('genre'));
    test.target.taxonomies.push(taxonomy('topic'));
    test.target.taxonomies[0]!.objectTypes = ['movie', 'post'];
    const result = await test.compare();
    expect(result.contentTypes.sourceOnly).toEqual(['movie']);
    expect(result.contentTypes.targetOnly).toEqual(['portfolio']);
    expect(result.contentTypes.shared).toEqual(['post']);
    expect(result.contentTypes.changed[0]).toEqual({
      name: 'post',
      differences: {
        hierarchical: { status: 'different', source: false, target: true },
        rewriteSlug: {
          status: 'different',
          source: 'news',
          target: 'articles',
        },
      },
    });
    expect(result.contentTypes.volumes).toContainEqual({
      name: 'post',
      source: 20,
      target: 2,
    });
    expect(result.taxonomies.sourceOnly).toEqual(['genre']);
    expect(result.taxonomies.targetOnly).toEqual(['topic']);
    expect(result.taxonomies.changed[0]?.differences.objectTypes).toEqual({
      status: 'different',
      source: ['post'],
      target: ['movie', 'post'],
    });
    expect(result.conflicts.map(({ code }) => code)).toEqual([
      'CONTENT_TYPE_MISSING_ON_TARGET',
      'TAXONOMY_MISSING_ON_TARGET',
    ]);
    expect(result.warnings.map(({ code }) => code)).toEqual([
      'CONTENT_TYPE_CONFIGURATION_MISMATCH',
      'TAXONOMY_CONFIGURATION_MISMATCH',
    ]);
  });

  it('treats sets as unordered, counts as volumes, and missing metadata as unknown', async () => {
    const test = setup();
    Object.assign(test.source.contentTypes[0]!, {
      supports: ['editor', 'title'],
      postCount: 200,
      restBase: 'posts',
    });
    Object.assign(test.source.taxonomies[0]!, {
      objectTypes: ['post', 'movie'],
      termCount: 500,
    });
    test.target.taxonomies[0]!.objectTypes = ['movie', 'post'];
    const result = await test.compare();
    expect(result.contentTypes.changed).toEqual([]);
    expect(result.taxonomies.changed).toEqual([]);
    expect(result.contentTypes.unavailable[0]?.fields.restBase).toEqual({
      status: 'unknown',
      source: 'posts',
    });
    expect(result.taxonomies.volumes).toEqual([
      { name: 'category', source: 500, target: 0 },
    ]);
    expect(result.conflicts).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('preserves the semantic order of singular/plural capability types', async () => {
    const test = setup();
    test.source.contentTypes[0]!.capabilityType = ['book', 'books'];
    test.target.contentTypes[0]!.capabilityType = ['books', 'book'];
    expect(
      (await test.compare()).contentTypes.changed[0]?.differences.capabilityType
        ?.status,
    ).toBe('different');
  });

  it('is deterministic across reordered input and does not mutate analyzer results', async () => {
    const test = setup();
    test.source.contentTypes.push(contentType('z_type'), contentType('a_type'));
    test.source.taxonomies.push(taxonomy('z_tax'), taxonomy('a_tax'));
    test.source.customTables.push(table('wp_events'), {
      ...table('wp_audit'),
      logicalName: 'audit',
    });
    test.source.users.roleCounts = { subscriber: 3, author: 2 };
    test.source.urls.externalMediaHostCounts = {
      'z.example.com': 4,
      'a.example.com': 2,
    };
    test.source.media.warnings = [
      { code: 'Z', message: 'Z' },
      { code: 'A', message: 'A' },
    ];
    const before = structuredClone(test.source);
    const first = await test.compare();
    expect(test.source).toEqual(before);
    test.source.contentTypes.reverse();
    test.source.taxonomies.reverse();
    test.source.customTables.reverse();
    test.source.contentTypes[0]!.supports.reverse();
    test.source.media.warnings.reverse();
    test.source.users.roleCounts = { author: 2, subscriber: 3 };
    test.source.urls.externalMediaHostCounts = {
      'a.example.com': 2,
      'z.example.com': 4,
    };
    expect(JSON.stringify(await test.compare())).toBe(JSON.stringify(first));
    expect(first.summary).toEqual({
      conflictCount: first.conflicts.length,
      warningCount: first.warnings.length,
      blockingConflictCount: first.conflicts.filter(
        (f) => f.severity === 'blocking',
      ).length,
    });
    expect(first.conflicts.map(({ code }) => code)).toEqual([
      'CONTENT_TYPE_MISSING_ON_TARGET',
      'CONTENT_TYPE_MISSING_ON_TARGET',
      'CUSTOM_TABLE_MISSING_ON_TARGET',
      'CUSTOM_TABLE_MISSING_ON_TARGET',
      'TAXONOMY_MISSING_ON_TARGET',
      'TAXONOMY_MISSING_ON_TARGET',
    ]);
  });

  it('projects selected metadata and strips URL credentials, query strings and fragments', async () => {
    const test = setup();
    Object.assign(test.source.site, {
      siteUrl: 'https://admin:secret@example.com/?token=secret#secret',
      password: 'secret',
    });
    Object.assign(test.source.database, {
      databaseHost: 'secret',
      databaseName: 'secret',
      password: 'secret',
    });
    Object.assign(test.source.users, {
      emails: ['secret'],
      passwordHashes: ['secret'],
    });
    Object.assign(test.source.urls, { rawMatches: ['secret'] });
    test.source.media.uploadBaseUrl =
      'https://admin:secret@example.com/uploads?token=secret#secret';
    const result = await test.compare();
    expect(result.source.siteUrl).toBe('https://example.com/');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.media.uploads.differences).toEqual({});
  });

  it.each(['', ' ', 'relative/path', '/bad\0path'])(
    'rejects invalid paths before constructing services: %j',
    async (path) => {
      const test = setup();
      await expect(
        test.service.compare({ ...input, sourcePath: path }),
      ).rejects.toThrow('absolute paths');
      await expect(
        test.service.compare({ ...input, targetPath: path }),
      ).rejects.toThrow('absolute paths');
      expect(test.factory).not.toHaveBeenCalled();
    },
  );

  it.each(
    Array.from({ length: 16 }, (_, index) => ({
      stage: index % 8,
      side: index < 8 ? 'source' : 'target',
    })),
  )(
    'propagates $side stage $stage failures and skips later stages',
    async ({ stage, side }) => {
      const test = setup();
      const error = new WpCliOutputError('inspection');
      calls(side === 'source' ? test.left : test.right)[
        stage
      ]!.mockRejectedValue(error);
      await expect(test.compare()).rejects.toBe(error);
      for (const services of [test.left, test.right])
        calls(services).forEach((call, index) =>
          expect(call).toHaveBeenCalledTimes(index <= stage ? 1 : 0),
        );
    },
  );

  it('waits for both sides to settle and chooses the source error when both fail', async () => {
    const test = setup();
    const error = new Error('source failed');
    let rejectTarget!: (error: Error) => void;
    test.left.site.getSiteInfo.mockRejectedValue(error);
    test.right.site.getSiteInfo.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectTarget = reject;
        }),
    );
    let settled = false;
    const pending = test.compare().catch((reason: unknown) => {
      settled = true;
      return reason;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    rejectTarget(new Error('target failed'));
    expect(await pending).toBe(error);
    expect(test.left.database.getDatabaseInfo).not.toHaveBeenCalled();
  });

  it('limits execution to one service pair at a time', async () => {
    const test = setup();
    let active = 0;
    let peak = 0;
    const delayed = async <T>(value: T): Promise<T> => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return value;
    };
    for (const [services, data] of [
      [test.left, test.source],
      [test.right, test.target],
    ] as const) {
      services.site.getSiteInfo.mockImplementation(() => delayed(data.site));
      services.database.getDatabaseInfo.mockImplementation(() =>
        delayed(data.database),
      );
      services.contentTypes.analyze.mockImplementation(() =>
        delayed(data.contentTypes),
      );
      services.taxonomies.analyze.mockImplementation(() =>
        delayed(data.taxonomies),
      );
      services.customTables.analyze.mockImplementation(() =>
        delayed(data.customTables),
      );
      services.users.analyze.mockImplementation(() => delayed(data.users));
      services.media.analyze.mockImplementation(() => delayed(data.media));
      services.urls.analyze.mockImplementation(() => delayed(data.urls));
    }
    await test.compare();
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });
});
