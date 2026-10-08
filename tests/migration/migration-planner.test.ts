import { describe, expect, it } from 'vitest';
import { MigrationPlanner } from '../../src/migration/migration-planner.js';
import type { MigrationPlan } from '../../src/migration/migration-plan.js';
import type { MigrationConflict } from '../../src/migration/comparison-model.js';
import {
  identicalComparison,
  comparisonWithRisks,
} from '../fixtures/site-comparison-result.js';

const planner = new MigrationPlanner();
const plan = (comparison = identicalComparison()) =>
  planner.generatePlan({ comparison });
const steps = (result: MigrationPlan) =>
  result.phases.flatMap(({ steps }) => steps);
const finding = (
  code: string,
  category: MigrationConflict['category'],
  severity: MigrationConflict['severity'] = 'warning',
  details?: Record<string, unknown>,
): MigrationConflict => ({
  code,
  category,
  severity,
  message: `Review ${code}.`,
  ...(details ? { details } : {}),
});

describe('MigrationPlanner', () => {
  it('returns a ready plan with only baseline phases for a clean comparison', () => {
    const result = plan();
    expect(result.readiness).toBe('ready');
    expect(result.kind).toBe('migration-plan');
    expect(result.executionPerformed).toBe(false);
    expect(result.phases.map(({ id }) => id)).toEqual([
      'preflight',
      'validation',
    ]);
    expect(result.summary).toEqual({
      blockerCount: 0,
      warningCount: 0,
      stepCount: 2,
    });
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.unresolvedDecisions).toEqual([]);
    expect(result.manualReviewItems).toEqual([]);
    expect(result.validationChecks.map(({ id }) => id)).toEqual([
      'validate-site-configuration',
    ]);
  });

  it.each([
    { severity: 'info' as const, readiness: 'ready' },
    { severity: 'warning' as const, readiness: 'ready_with_warnings' },
    { severity: 'high' as const, readiness: 'ready_with_warnings' },
    { severity: 'blocking' as const, readiness: 'blocked' },
  ])(
    'derives $readiness from $severity findings, not cached summary counts',
    ({ severity, readiness }) => {
      const c = identicalComparison();
      c.conflicts = [finding('FUTURE_RISK', 'environment', severity)];
      c.summary = {
        conflictCount: 999,
        warningCount: 999,
        blockingConflictCount: 999,
      };
      const result = plan(c);
      expect(result.readiness).toBe(readiness);
      expect(result.summary.blockerCount).toBe(severity === 'blocking' ? 1 : 0);
      expect(result.summary.warningCount).toBe(severity === 'blocking' ? 0 : 1);
      if (severity !== 'info')
        expect(result.manualReviewItems).toContain(
          'review-environment-FUTURE_RISK',
        );
    },
  );

  it.each([
    [
      'MULTISITE_MODE_MISMATCH',
      'environment',
      'resolve-multisite-strategy',
      'high',
      'choose-multisite-migration-strategy',
    ],
    [
      'CONTENT_TYPE_MISSING_ON_TARGET',
      'content-type',
      'prepare-content-type-registrations',
      'medium',
      'choose-content-type-scope',
    ],
    [
      'CONTENT_TYPE_CONFIGURATION_MISMATCH',
      'content-type',
      'reconcile-content-type-settings',
      'medium',
      undefined,
    ],
    [
      'TAXONOMY_MISSING_ON_TARGET',
      'taxonomy',
      'prepare-taxonomy-registrations',
      'medium',
      'choose-taxonomy-scope',
    ],
    [
      'TAXONOMY_CONFIGURATION_MISMATCH',
      'taxonomy',
      'reconcile-taxonomy-settings',
      'medium',
      undefined,
    ],
    [
      'CUSTOM_TABLE_MISSING_ON_TARGET',
      'database',
      'review-custom-table-provisioning',
      'high',
      'choose-custom-table-scope',
    ],
    [
      'CUSTOM_TABLE_METADATA_MISMATCH',
      'database',
      'review-custom-table-provisioning',
      'high',
      'choose-custom-table-scope',
    ],
    [
      'USER_ID_RANGE_OVERLAP',
      'user',
      'define-user-id-strategy',
      'high',
      'choose-user-id-strategy',
    ],
    [
      'UPLOAD_CONFIGURATION_MISMATCH',
      'media',
      'reconcile-upload-configuration',
      'medium',
      'choose-upload-configuration',
    ],
    [
      'SOURCE_ENVIRONMENT_REFERENCES_FOUND',
      'url',
      'define-reference-policy',
      'medium',
      'choose-reference-mapping',
    ],
    [
      'DEVELOPMENT_URL_REFERENCES',
      'url',
      'review-development-references',
      'medium',
      'choose-development-reference-policy',
    ],
    [
      'UPLOAD_HOST_MISMATCH',
      'url',
      'review-upload-host-mapping',
      'medium',
      'choose-upload-host-policy',
    ],
    [
      'VERSION_DIFFERENCE',
      'environment',
      'review-runtime-compatibility',
      'medium',
      undefined,
    ],
    [
      'DATABASE_CONFIGURATION_MISMATCH',
      'database',
      'review-database-compatibility',
      'medium',
      undefined,
    ],
  ] satisfies [
    string,
    MigrationConflict['category'],
    string,
    string,
    string | undefined,
  ][])(
    'maps %s to explicit preparation without copying severity into risk',
    (code, category, id, risk, decisionId) => {
      const c = identicalComparison();
      c.conflicts = [finding(code, category, 'high')];
      const result = plan(c);
      const step = steps(result).find((step) => step.id === id);
      expect(step).toMatchObject({
        risk,
        automated: false,
        requiresConfirmation: true,
        reason: expect.stringContaining(code),
      });
      expect(result.manualReviewItems).toContain(id);
      expect(result.warnings[0]).toMatchObject({
        code,
        severity: 'high',
        sourceConflictCode: code,
      });
      expect(result.readiness).toBe('ready_with_warnings');
      if (decisionId)
        expect(result.unresolvedDecisions).toContainEqual(
          expect.objectContaining({ id: decisionId }),
        );
    },
  );

  it('preserves a blocking topology issue and leaves topology options unselected in either direction', () => {
    for (const sourceMultisite of [true, false]) {
      const c = identicalComparison();
      c.source.multisite = sourceMultisite;
      c.target.multisite = !sourceMultisite;
      c.conflicts = [
        finding('MULTISITE_MODE_MISMATCH', 'environment', 'blocking'),
      ];
      const result = plan(c);
      expect(result.readiness).toBe('blocked');
      expect(result.blockers[0]?.severity).toBe('blocking');
      expect(result.unresolvedDecisions[0]).toMatchObject({
        id: 'choose-multisite-migration-strategy',
        options: [
          'align-installation-modes',
          'design-explicit-topology-conversion',
          'defer-migration',
        ],
      });
      expect(result.unresolvedDecisions[0]).not.toHaveProperty(
        'selectedOption',
      );
    }
  });

  it('groups multiple missing registrations into one step with sorted affected keys', () => {
    const c = identicalComparison();
    c.taxonomies.sourceOnly = ['z_genre', 'a_genre'];
    c.conflicts = ['z_genre', 'a_genre', 'z_genre'].map((name) =>
      finding('TAXONOMY_MISSING_ON_TARGET', 'taxonomy', 'high', { name }),
    );
    const result = plan(c);
    const matching = steps(result).filter(
      ({ id }) => id === 'prepare-taxonomy-registrations',
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]?.affectedObjects).toEqual(['a_genre', 'z_genre']);
    expect(
      result.unresolvedDecisions.find(
        ({ id }) => id === 'choose-taxonomy-scope',
      )?.affectedObjects,
    ).toEqual(['a_genre', 'z_genre']);
    expect(result.warnings).toHaveLength(2);
    expect(
      result.validationChecks.filter(
        ({ id }) => id === 'validate-taxonomy-registrations',
      ),
    ).toHaveLength(1);
  });

  it('coalesces related custom-table risks while retaining separate configuration work', () => {
    const c = identicalComparison();
    c.conflicts = [
      finding('CUSTOM_TABLE_MISSING_ON_TARGET', 'database', 'high', {
        sourceName: 'wp_a',
      }),
      finding('CUSTOM_TABLE_SCOPE_UNVERIFIED', 'database', 'warning', {
        names: ['wp_b', 'wp_a'],
        side: 'source',
      }),
      finding('CUSTOM_TABLE_MATCH_AMBIGUOUS', 'database', 'warning', {
        sourceNames: ['wp_b'],
        targetNames: ['other_b'],
      }),
      finding('DATABASE_CONFIGURATION_MISMATCH', 'database'),
    ];
    const result = plan(c);
    expect(
      steps(result).filter(
        ({ id }) => id === 'review-custom-table-provisioning',
      ),
    ).toHaveLength(1);
    expect(
      steps(result).find(({ id }) => id === 'review-custom-table-provisioning')
        ?.affectedObjects,
    ).toEqual(['other_b', 'wp_a', 'wp_b']);
    expect(
      steps(result).some(({ id }) => id === 'review-database-compatibility'),
    ).toBe(true);
  });

  it('does not mark a plan ready when comparison sections require decisions without explicit findings', () => {
    const c = identicalComparison();
    c.contentTypes.sourceOnly = ['movie'];
    const result = plan(c);
    expect(result.readiness).toBe('ready_with_warnings');
    expect(result.warnings).toEqual([]);
    expect(result.unresolvedDecisions.map(({ id }) => id)).toEqual([
      'choose-content-type-scope',
    ]);
  });

  it('uses source counts as volume and makes only relevant content/term phases and checks', () => {
    const c = identicalComparison();
    c.contentTypes.volumes = [{ name: 'post', source: 100, target: 0 }];
    c.taxonomies.volumes = [{ name: 'genre', source: 10, target: 0 }];
    const result = plan(c);
    expect(result.readiness).toBe('ready');
    expect(result.warnings).toEqual([]);
    expect(result.phases.map(({ id }) => id)).toEqual([
      'preflight',
      'content-and-taxonomies',
      'validation',
    ]);
    expect(
      steps(result)
        .filter(({ automated }) => automated)
        .map(({ id }) => id),
    ).toEqual([
      'plan-content-transfer',
      'plan-term-transfer',
      'validate-approved-migration',
    ]);
    expect(result.validationChecks.map(({ id }) => id)).toEqual([
      'validate-content-counts',
      'validate-content-registrations',
      'validate-site-configuration',
      'validate-taxonomy-registrations',
      'validate-term-counts',
    ]);
  });

  it('does not migrate target-only or zero-volume registrations', () => {
    const c = identicalComparison();
    c.contentTypes.targetOnly = ['target'];
    c.contentTypes.volumes = [
      { name: 'empty', source: 0, target: 0 },
      { name: 'target', target: 30 },
    ];
    c.taxonomies.volumes = [{ name: 'empty_terms', source: 0 }];
    expect(plan(c).phases.map(({ id }) => id)).toEqual([
      'preflight',
      'validation',
    ]);
  });

  it('requires target-data policy when nonempty source and target scopes coexist', () => {
    const c = identicalComparison();
    c.contentTypes.volumes = [{ name: 'post', source: 20, target: 20 }];
    const result = plan(c);
    expect(result.readiness).toBe('ready_with_warnings');
    expect(result.unresolvedDecisions).toContainEqual(
      expect.objectContaining({ id: 'choose-existing-target-data-policy' }),
    );
    expect(result.warnings).toEqual([]);
  });

  it.each(['unknown', 'disjoint', 'empty'] as const)(
    'does not infer user identity from %s ranges',
    (idRangeStatus) => {
      const c = identicalComparison();
      c.users.idRangeStatus = idRangeStatus;
      c.users.metrics.totalUsers.source = 10;
      const result = plan(c);
      expect(result.unresolvedDecisions).toContainEqual(
        expect.objectContaining({ id: 'choose-user-id-strategy' }),
      );
      expect(
        steps(result).some(({ id }) => id === 'define-user-id-strategy'),
      ).toBe(false);
      expect(result.validationChecks).toContainEqual(
        expect.objectContaining({ id: 'validate-user-mapping' }),
      );
      expect(result.readiness).toBe('ready_with_warnings');
      expect(result).not.toHaveProperty('userMapping');
    },
  );

  it('plans matched and missing custom tables only after an explicit scope decision', () => {
    const c = identicalComparison();
    c.customTables.sourceOnly = [
      { name: 'wp_metrics', scope: 'site', usesWordPressPrefix: true },
    ];
    c.customTables.ambiguous = [
      { sourceNames: ['wp_a', 'wp_b'], targetNames: ['other_a'] },
    ];
    const result = plan(c);
    expect(
      steps(result).find(({ id }) => id === 'plan-approved-table-transfer')
        ?.affectedObjects,
    ).toEqual(['wp_a', 'wp_b', 'wp_metrics']);
    expect(result.unresolvedDecisions).toContainEqual(
      expect.objectContaining({ id: 'choose-custom-table-scope' }),
    );
    expect(result.validationChecks.map(({ id }) => id)).toContain(
      'validate-custom-table-counts',
    );
    expect(
      result.validationChecks.find(
        ({ id }) => id === 'validate-custom-table-counts',
      )?.description,
    ).toContain('estimates');
  });

  it('plans attachments and external hosting without assuming local files exist or copying them', () => {
    const c = identicalComparison();
    c.media.metrics.totalAttachments.source = 10;
    c.media.metrics.externalMediaCount.source = 4;
    const result = plan(c);
    expect(steps(result).some(({ id }) => id === 'plan-media-transfer')).toBe(
      true,
    );
    expect(result.unresolvedDecisions).toContainEqual(
      expect.objectContaining({ id: 'choose-external-media-policy' }),
    );
    expect(result.validationChecks.map(({ id }) => id)).toEqual([
      'validate-attachment-counts',
      'validate-media-availability',
      'validate-site-configuration',
    ]);
    expect(
      result.validationChecks.find(
        ({ id }) => id === 'validate-media-availability',
      )?.description,
    ).toContain('offloaded files need not exist locally');
  });

  it('uses observed media hosts as dependency hints, not automatic ownership assignments', () => {
    const c = identicalComparison();
    c.urlReferences.sourceOnlyObservedMediaHosts = [
      { host: 'cdn.example.com', referenceCount: 5 },
    ];
    const result = plan(c);
    expect(result.unresolvedDecisions[0]?.id).toBe(
      'choose-external-media-policy',
    );
    expect(result.unresolvedDecisions[0]?.reason).toContain('not proof');
    expect(result.readiness).toBe('ready_with_warnings');
  });

  it('plans source/development reference policies from comparison metrics without replacements', () => {
    const c = identicalComparison();
    c.urlReferences.metrics.sourceUrlReferences.source = 10;
    c.urlReferences.metrics.developmentReferenceCount.target = 2;
    const result = plan(c);
    expect(result.unresolvedDecisions.map(({ id }) => id)).toEqual([
      'choose-development-reference-policy',
      'choose-reference-mapping',
    ]);
    expect(result.validationChecks.map(({ id }) => id)).toEqual([
      'validate-development-references',
      'validate-site-configuration',
      'validate-source-references',
    ]);
    expect(
      result.validationChecks.find(
        ({ id }) => id === 'validate-source-references',
      )?.description,
    ).toContain('intentional');
    expect(result).not.toHaveProperty('replacements');
  });

  it('handles wrapped analyzer warnings and direct codes without duplicate URL work', () => {
    const c = identicalComparison();
    c.conflicts = [
      finding('DEVELOPMENT_URL_REFERENCES', 'url'),
      finding('ANALYZER_WARNING', 'url', 'warning', {
        analyzerCode: 'DEVELOPMENT_URL_REFERENCES',
        side: 'source',
        count: 2,
      }),
      finding('SOURCE_ENVIRONMENT_REFERENCES_FOUND', 'url'),
      finding('ANALYZER_WARNING', 'url', 'warning', {
        analyzerCode: 'SOURCE_DOMAIN_REFERENCES_FOUND',
        side: 'source',
      }),
    ];
    const result = plan(c);
    expect(
      steps(result).filter(({ id }) => id === 'review-development-references'),
    ).toHaveLength(1);
    expect(
      steps(result).filter(({ id }) => id === 'define-reference-policy'),
    ).toHaveLength(1);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        sourceConflictCode: 'ANALYZER_WARNING',
        sourceAnalyzerCode: 'DEVELOPMENT_URL_REFERENCES',
        side: 'source',
      }),
    );
  });

  it('keeps unsupported and incomplete-analysis warnings as review work', () => {
    const c = identicalComparison();
    c.warnings = [
      {
        ...finding('ANALYZER_WARNING', 'url', 'warning', {
          analyzerCode: 'HOST_SUMMARY_LIMIT',
          side: 'source',
        }),
        severity: 'warning',
      },
      {
        ...finding('ANALYZER_WARNING', 'media', 'warning', {
          analyzerCode: 'LOCAL_FILES_NOT_CHECKED',
          side: 'target',
        }),
        severity: 'warning',
      },
    ];
    const result = plan(c);
    expect(result.readiness).toBe('ready_with_warnings');
    expect(result.manualReviewItems).toEqual([
      'review-media-LOCAL_FILES_NOT_CHECKED',
      'review-url-HOST_SUMMARY_LIMIT',
    ]);
    expect(result.validationChecks).toContainEqual(
      expect.objectContaining({ id: 'validate-review-url-HOST_SUMMARY_LIMIT' }),
    );
  });

  it('orders phases and dependencies without cycles or missing phase references', () => {
    const c = comparisonWithRisks();
    c.media.metrics.totalAttachments.source = 5;
    const result = plan(c);
    const seen = new Set<string>();
    expect(result.phases.map(({ id }) => id)).toEqual([
      'preflight',
      'environment-preparation',
      'schema-and-plugin-preparation',
      'users',
      'content-and-taxonomies',
      'custom-tables',
      'media',
      'url-rewrite',
      'validation',
    ]);
    result.phases.forEach((phase, index) => {
      expect(phase.order).toBe(index + 1);
      expect(phase.steps.length).toBeGreaterThan(0);
      for (const dependency of phase.dependsOn)
        expect(seen.has(dependency)).toBe(true);
      expect(phase.dependsOn).not.toContain(phase.id);
      seen.add(phase.id);
    });
    expect(result.phases.at(-1)?.dependsOn).toEqual(
      result.phases.slice(0, -1).map(({ id }) => id),
    );
    expect(
      result.phases.find(({ id }) => id === 'content-and-taxonomies')
        ?.dependsOn,
    ).toEqual([
      'preflight',
      'environment-preparation',
      'schema-and-plugin-preparation',
      'users',
    ]);
  });

  it('produces deterministic output across reordered evidence and nested detail keys', () => {
    const c = comparisonWithRisks();
    c.conflicts.push(
      finding('FUTURE_WARNING', 'user', 'high', {
        sourceName: 'b',
        names: ['z', 'a'],
      }),
    );
    c.conflicts.push(
      finding('ANALYZER_WARNING', 'user', 'warning', {
        analyzerCode: 'FUTURE_WARNING',
        names: ['a'],
      }),
    );
    const first = plan(c);
    c.conflicts.reverse();
    c.warnings.reverse();
    c.contentTypes.volumes.reverse();
    c.taxonomies.sourceOnly.reverse();
    c.customTables.sourceOnly.reverse();
    for (const conflict of c.conflicts)
      if (conflict.details)
        conflict.details = Object.fromEntries(
          Object.entries(conflict.details).reverse(),
        );
    expect(JSON.stringify(plan(c))).toBe(JSON.stringify(first));
    for (const phase of first.phases)
      expect(phase.steps.map(({ id }) => id)).toEqual(
        phase.steps.map(({ id }) => id).sort(),
      );
    expect(first.unresolvedDecisions.map(({ id }) => id)).toEqual(
      first.unresolvedDecisions.map(({ id }) => id).sort(),
    );
    expect(first.validationChecks.map(({ id }) => id)).toEqual(
      first.validationChecks.map(({ id }) => id).sort(),
    );
  });

  it('sorts issues by severity and computes summary counts from the resulting plan', () => {
    const c = comparisonWithRisks();
    c.conflicts.push(finding('A_BLOCKER', 'database', 'blocking'));
    const result = plan(c);
    expect(result.blockers).toHaveLength(2);
    expect(result.warnings[0]?.severity).toBe('high');
    expect(result.warnings.at(-1)?.severity).toBe('info');
    expect(result.summary).toEqual({
      blockerCount: result.blockers.length,
      warningCount: result.warnings.length,
      stepCount: steps(result).length,
    });
    expect(new Set(steps(result).map(({ id }) => id)).size).toBe(
      steps(result).length,
    );
    expect(new Set(result.unresolvedDecisions.map(({ id }) => id)).size).toBe(
      result.unresolvedDecisions.length,
    );
  });

  it('does not mutate input or share mutable data between plans', () => {
    const c = comparisonWithRisks();
    const before = structuredClone(c);
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
    };
    freeze(c);
    const first = plan(c);
    const baseline = structuredClone(first);
    steps(first)[0]!.description = 'changed';
    first.unresolvedDecisions[0]?.options?.push('changed');
    first.validationChecks[0]!.description = 'changed';
    expect(plan(c)).toEqual(baseline);
    expect(c).toEqual(before);
  });

  it('returns JSON-friendly plan-only metadata without raw internals, executable commands or completion markers', () => {
    const c = comparisonWithRisks();
    Object.assign(c, { rawSql: 'private SQL', rawContent: 'private content' });
    Object.assign(c.conflicts[0]!.details!, {
      password: 'private secret',
      rows: ['private rows'],
    });
    const result = plan(c);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(result.executionPerformed).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toMatch(
      /wp search-replace|CREATE TABLE|rsync |mysql |"completed"|"command"|"sql"/i,
    );
    for (const step of steps(result)) {
      expect(step.reason.length).toBeGreaterThan(0);
      expect(step).not.toHaveProperty('status');
      expect(step).not.toHaveProperty('executed');
    }
  });
});
