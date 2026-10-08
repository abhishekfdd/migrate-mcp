import { describe, expect, it } from 'vitest';
import { setup, table } from '../fixtures/site-comparison.js';

describe('custom table comparison', () => {
  it('matches active-site logical names across prefixes and retains volume estimates', async () => {
    const test = setup();
    test.source.customTables = [table()];
    test.target.customTables = [
      { ...table('target_3_events'), rowCount: 20, sizeBytes: 4096, siteId: 3 },
    ];
    const result = await test.compare();
    expect(result.customTables.sourceOnly).toEqual([]);
    expect(result.customTables.targetOnly).toEqual([]);
    expect(result.customTables.shared).toEqual([
      expect.objectContaining({
        matchingBasis: 'active-site-logical-name',
        source: expect.objectContaining({
          name: 'wp_events',
          rowCount: 10,
          sizeBytes: 2048,
        }),
        target: expect.objectContaining({
          name: 'target_3_events',
          rowCount: 20,
          sizeBytes: 4096,
        }),
        metadata: {
          differences: {},
          unavailable: { likelyOwner: { status: 'unknown' } },
        },
      }),
    ]);
    expect(result.conflicts).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('reports missing active-site tables as high risks without claiming a plugin is missing', async () => {
    const test = setup();
    test.source.customTables = [{ ...table(), likelyOwner: 'Example plugin' }];
    test.target.customTables = [{ ...table('wp_audit'), logicalName: 'audit' }];
    const result = await test.compare();
    expect(result.customTables.sourceOnly.map(({ name }) => name)).toEqual([
      'wp_events',
    ]);
    expect(result.customTables.targetOnly.map(({ name }) => name)).toEqual([
      'wp_audit',
    ]);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        code: 'CUSTOM_TABLE_MISSING_ON_TARGET',
        severity: 'high',
        details: {
          sourceName: 'wp_events',
          scope: 'site',
          likelyOwner: 'Example plugin',
        },
      }),
    ]);
  });

  it('reports engine, collation and owner differences as review warnings', async () => {
    const test = setup();
    test.source.customTables = [{ ...table(), likelyOwner: 'Plugin A' }];
    test.target.customTables = [
      {
        ...table(),
        engine: 'MyISAM',
        collation: 'latin1_swedish_ci',
        likelyOwner: 'Plugin B',
      },
    ];
    const result = await test.compare();
    expect(
      Object.keys(result.customTables.shared[0]!.metadata.differences),
    ).toEqual(['collation', 'engine', 'likelyOwner']);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'CUSTOM_TABLE_METADATA_MISMATCH',
        severity: 'warning',
      }),
    );
    expect(result.conflicts).toEqual([]);
  });

  it('retains unknown metadata without substituting zero or declaring incompatibility', async () => {
    const test = setup();
    test.source.customTables = [
      {
        name: 'wp_events',
        logicalName: 'events',
        scope: 'site',
        usesWordPressPrefix: true,
      },
    ];
    test.target.customTables = [table()];
    const result = await test.compare();
    expect(result.customTables.shared[0]?.source).not.toHaveProperty(
      'rowCount',
    );
    expect(result.customTables.shared[0]?.metadata.unavailable.engine).toEqual({
      status: 'unknown',
      target: 'InnoDB',
    });
    expect(result.warnings).toEqual([]);
  });

  it('does not equate other-site, active-site or unprefixed tables by logical name', async () => {
    const test = setup();
    test.source.customTables = [
      { ...table('wp_4_events'), usesWordPressPrefix: false, siteId: 4 },
      { name: 'external', scope: 'unprefixed', usesWordPressPrefix: false },
    ];
    test.target.customTables = [
      table('target_events'),
      {
        name: 'other_external',
        scope: 'unprefixed',
        usesWordPressPrefix: false,
      },
    ];
    const result = await test.compare();
    expect(result.customTables.shared).toEqual([]);
    expect(result.customTables.sourceOnly.map(({ name }) => name)).toEqual([
      'external',
      'wp_4_events',
    ]);
    expect(result.conflicts).toEqual([]);
    expect(
      result.warnings.filter(
        ({ code }) => code === 'CUSTOM_TABLE_MISSING_ON_TARGET',
      ),
    ).toHaveLength(2);
    expect(
      result.warnings.filter(
        ({ code }) => code === 'CUSTOM_TABLE_SCOPE_UNVERIFIED',
      ),
    ).toHaveLength(2);
  });

  it('marks ambiguous network/main-site scope even when logical names match', async () => {
    const test = setup();
    test.source.customTables = [{ ...table(), scope: 'network-or-main-site' }];
    test.target.customTables = [
      { ...table('target_events'), scope: 'network-or-main-site' },
    ];
    const result = await test.compare();
    expect(result.customTables.shared[0]?.matchingBasis).toBe(
      'network-or-main-site-logical-name',
    );
    expect(
      result.warnings.filter(
        ({ code }) => code === 'CUSTOM_TABLE_SCOPE_UNVERIFIED',
      ),
    ).toHaveLength(2);
  });

  it('allows exact-name/scope matches without certifying ownership', async () => {
    const test = setup();
    const external = {
      name: 'analytics',
      scope: 'unprefixed' as const,
      usesWordPressPrefix: false,
    };
    test.source.customTables = [external];
    test.target.customTables = [{ ...external }];
    const result = await test.compare();
    expect(result.customTables.shared[0]?.matchingBasis).toBe(
      'exact-name-and-scope',
    );
    expect(
      result.warnings.every(
        ({ code }) => code === 'CUSTOM_TABLE_SCOPE_UNVERIFIED',
      ),
    ).toBe(true);
  });

  it('surfaces ambiguous matching identities without arbitrarily pairing tables', async () => {
    const test = setup();
    test.source.customTables = [table('wp_b'), table('wp_a')];
    test.target.customTables = [table('wp_c')];
    const result = await test.compare();
    expect(result.customTables.ambiguous).toEqual([
      { sourceNames: ['wp_a', 'wp_b'], targetNames: ['wp_c'] },
    ]);
    expect(result.customTables.shared).toEqual([]);
    expect(result.customTables.sourceOnly).toEqual([]);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'CUSTOM_TABLE_MATCH_AMBIGUOUS' }),
    );
  });
});
