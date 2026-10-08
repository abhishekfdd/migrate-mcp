import {
  compareText,
  sortedSet,
  type MigrationConflict,
  type ValueComparison,
} from './comparison-model.js';
import type { SiteComparison } from './site-comparison.js';
import type { MigrationPlanIssue } from './migration-plan.js';

const severityOrder = { blocking: 0, high: 1, warning: 2, info: 3 };
export const positive = (value: unknown): boolean =>
  typeof value === 'number' && value > 0;
export const eitherPositive = (metric: ValueComparison): boolean =>
  positive(metric.source) || positive(metric.target);

export function affected(finding: MigrationConflict): string[] {
  const details = finding.details ?? {};
  return sortedSet(
    [
      details.name,
      details.sourceName,
      details.targetName,
      ...['names', 'sourceNames', 'targetNames'].flatMap((key) =>
        Array.isArray(details[key]) ? details[key] : [],
      ),
    ].filter((value): value is string => typeof value === 'string'),
  );
}

export function effectiveCode(finding: MigrationConflict): string {
  return finding.code === 'ANALYZER_WARNING' &&
    typeof finding.details?.analyzerCode === 'string'
    ? finding.details.analyzerCode
    : finding.code;
}

export function planIssues(
  findings: MigrationConflict[],
): MigrationPlanIssue[] {
  const unique = new Map<string, MigrationPlanIssue>();
  for (const finding of findings) {
    const objects = affected(finding);
    const side = finding.details?.side;
    const issue: MigrationPlanIssue = {
      code: finding.code,
      severity: finding.severity,
      category: finding.category,
      message: finding.message,
      sourceConflictCode: finding.code,
      ...(finding.code === 'ANALYZER_WARNING' &&
      typeof finding.details?.analyzerCode === 'string'
        ? { sourceAnalyzerCode: finding.details.analyzerCode }
        : {}),
      ...(side === 'source' || side === 'target' ? { side } : {}),
      ...(objects.length ? { affectedObjects: objects } : {}),
    };
    unique.set(JSON.stringify(issue), issue);
  }
  return [...unique.values()].sort(
    (a, b) =>
      severityOrder[a.severity] - severityOrder[b.severity] ||
      compareText(a.category, b.category) ||
      compareText(a.code, b.code) ||
      compareText(JSON.stringify(a), JSON.stringify(b)),
  );
}

/** Translate existing comparison sections into planning triggers, not new conflicts. */
export function scopeEvidence(c: SiteComparison) {
  const evidence = new Map<string, { reason: string; objects: string[] }>();
  const add = (
    id: string,
    active: boolean,
    reason: string,
    objects: string[] = [],
  ) => {
    if (active) evidence.set(id, { reason, objects: sortedSet(objects) });
  };
  add(
    'resolve-multisite-strategy',
    c.compatibility.multisite.status === 'different',
    'Comparison reports different installation modes.',
  );
  add(
    'review-runtime-compatibility',
    c.compatibility.wordpressVersion.status === 'different' ||
      c.compatibility.phpVersion.status === 'different',
    'Comparison reports different runtime versions.',
  );
  add(
    'prepare-content-type-registrations',
    c.contentTypes.sourceOnly.length > 0,
    'Comparison lists source-only content types.',
    c.contentTypes.sourceOnly,
  );
  add(
    'reconcile-content-type-settings',
    c.contentTypes.changed.length > 0,
    'Comparison lists changed content type configuration.',
    c.contentTypes.changed.map(({ name }) => name),
  );
  add(
    'prepare-taxonomy-registrations',
    c.taxonomies.sourceOnly.length > 0,
    'Comparison lists source-only taxonomies.',
    c.taxonomies.sourceOnly,
  );
  add(
    'reconcile-taxonomy-settings',
    c.taxonomies.changed.length > 0,
    'Comparison lists changed taxonomy configuration.',
    c.taxonomies.changed.map(({ name }) => name),
  );
  const tables = [
    ...c.customTables.sourceOnly.map(({ name }) => name),
    ...c.customTables.shared.map(({ source }) => source.name),
    ...c.customTables.ambiguous.flatMap(({ sourceNames }) => sourceNames),
  ];
  add(
    'review-custom-table-provisioning',
    tables.length > 0,
    'Source custom tables require an explicit scope and ownership decision; matches do not establish schema compatibility.',
    tables,
  );
  add(
    'review-database-compatibility',
    Object.keys(c.database.configuration.differences).length > 0,
    'Comparison reports database default differences.',
  );
  add(
    'define-user-id-strategy',
    c.users.idRangeStatus === 'overlap',
    'Comparison reports overlapping user ID ranges.',
  );
  add(
    'reconcile-upload-configuration',
    Object.keys(c.media.uploads.differences).length > 0,
    'Comparison reports upload configuration differences.',
  );
  add(
    'define-reference-policy',
    positive(c.urlReferences.metrics.sourceUrlReferences.source) ||
      positive(c.urlReferences.metrics.filesystemPathReferences.source),
    'Source-host references or filesystem indicators require an explicit retention/replacement policy.',
  );
  add(
    'review-development-references',
    eitherPositive(c.urlReferences.metrics.developmentReferenceCount),
    'Comparison reports development references.',
  );
  add(
    'review-upload-host-mapping',
    c.urlReferences.uploadHost.status === 'different',
    'Comparison reports different upload hostnames.',
  );
  return evidence;
}
