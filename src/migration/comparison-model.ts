export type MigrationSeverity = 'info' | 'warning' | 'high' | 'blocking';
export type MigrationCategory =
  | 'environment'
  | 'content-type'
  | 'taxonomy'
  | 'database'
  | 'user'
  | 'media'
  | 'url';
export type ComparisonValue = string | number | boolean | string[];

export interface ValueComparison<T = ComparisonValue> {
  status: 'equal' | 'different' | 'unknown';
  source?: T;
  target?: T;
}

export interface MigrationConflict {
  code: string;
  severity: MigrationSeverity;
  category: MigrationCategory;
  message: string;
  details?: Record<string, unknown>;
}

export interface MigrationWarning extends MigrationConflict {
  severity: 'info' | 'warning';
}

export interface ComparisonFindings {
  conflicts: MigrationConflict[];
  warnings: MigrationWarning[];
}

export const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
export const sortedSet = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareText);

export function compareValue<T extends ComparisonValue>(
  source: T | undefined,
  target: T | undefined,
): ValueComparison<T> {
  return {
    status:
      source === undefined || target === undefined
        ? 'unknown'
        : JSON.stringify(source) === JSON.stringify(target)
          ? 'equal'
          : 'different',
    ...(source === undefined
      ? {}
      : { source: (Array.isArray(source) ? [...source] : source) as T }),
    ...(target === undefined
      ? {}
      : { target: (Array.isArray(target) ? [...target] : target) as T }),
  };
}

/** Callers supply fixed field lists; unknown optional values are not mismatches. */
export function compareFields<T extends object>(
  source: T,
  target: T,
  fields: readonly (keyof T & string)[],
) {
  const differences: Record<string, ValueComparison> = {};
  const unavailable: Record<string, ValueComparison> = {};
  for (const field of [...fields].sort(compareText)) {
    const comparison = compareValue(
      source[field] as ComparisonValue | undefined,
      target[field] as ComparisonValue | undefined,
    );
    if (comparison.status === 'different') differences[field] = comparison;
    if (comparison.status === 'unknown') unavailable[field] = comparison;
  }
  return { differences, unavailable };
}

/** Explicitly selected scalar fields only; never project whole analyzer results. */
export function compareMetrics<T extends object, K extends keyof T & string>(
  source: T,
  target: T,
  fields: readonly K[],
): Record<K, ValueComparison> {
  return Object.fromEntries(
    [...fields]
      .sort(compareText)
      .map((field) => [
        field,
        compareValue(
          source[field] as ComparisonValue | undefined,
          target[field] as ComparisonValue | undefined,
        ),
      ]),
  ) as Record<K, ValueComparison>;
}

export function compareCounts(
  source: Record<string, number>,
  target: Record<string, number>,
) {
  return sortedSet([...Object.keys(source), ...Object.keys(target)]).map(
    (name) => ({
      name,
      source: Object.hasOwn(source, name) ? source[name]! : 0,
      target: Object.hasOwn(target, name) ? target[name]! : 0,
    }),
  );
}

export function analyzerWarnings(
  source: { code: string; message: string; count?: number }[],
  target: { code: string; message: string; count?: number }[],
  category: MigrationCategory,
  findings: ComparisonFindings,
): void {
  for (const [side, warnings] of [
    ['source', source],
    ['target', target],
  ] as const) {
    for (const warning of warnings)
      addFinding(findings, {
        code: 'ANALYZER_WARNING',
        category,
        severity: 'warning',
        message: warning.message,
        details: {
          side,
          analyzerCode: warning.code,
          ...(warning.count === undefined ? {} : { count: warning.count }),
        },
      });
  }
}

export function addFinding(
  findings: ComparisonFindings,
  finding: MigrationConflict,
): void {
  if (finding.severity === 'info' || finding.severity === 'warning')
    findings.warnings.push({ ...finding, severity: finding.severity });
  else findings.conflicts.push(finding);
}

export function sortFindings(findings: ComparisonFindings): void {
  const order = (a: MigrationConflict, b: MigrationConflict) =>
    compareText(a.category, b.category) ||
    compareText(a.code, b.code) ||
    compareText(
      JSON.stringify(a.details ?? {}),
      JSON.stringify(b.details ?? {}),
    ) ||
    compareText(a.message, b.message);
  findings.conflicts.sort(order);
  findings.warnings.sort(order);
}

/** Only configured URLs are displayed; credentials and token-bearing suffixes are omitted. */
export function publicSiteUrl(value: string): string {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function configuredHost(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return new URL(value).hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}
