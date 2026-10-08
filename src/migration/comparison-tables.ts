import type { CustomTableInfo } from './custom-table-analyzer.js';
import {
  addFinding,
  compareFields,
  compareText,
  sortedSet,
  type ComparisonFindings,
} from './comparison-model.js';

type TableSummary = Omit<
  CustomTableInfo,
  'referenceHints' | 'dataSizeBytes' | 'indexSizeBytes'
>;
type MatchBasis =
  | 'active-site-logical-name'
  | 'network-or-main-site-logical-name'
  | 'exact-name-and-scope';
export interface CustomTableComparison {
  sourceOnly: TableSummary[];
  targetOnly: TableSummary[];
  shared: {
    source: TableSummary;
    target: TableSummary;
    matchingBasis: MatchBasis;
    metadata: ReturnType<typeof compareFields<TableSummary>>;
  }[];
  ambiguous: { sourceNames: string[]; targetNames: string[] }[];
}

function identity(table: CustomTableInfo): { key: string; basis: MatchBasis } {
  if (
    table.logicalName &&
    table.scope === 'site' &&
    table.usesWordPressPrefix
  ) {
    return {
      key: JSON.stringify(['active', table.logicalName]),
      basis: 'active-site-logical-name',
    };
  }
  if (table.logicalName && table.scope === 'network-or-main-site') {
    return {
      key: JSON.stringify(['network-or-main-site', table.logicalName]),
      basis: 'network-or-main-site-logical-name',
    };
  }
  return {
    key: JSON.stringify(['exact', table.scope, table.name]),
    basis: 'exact-name-and-scope',
  };
}

function summarize(table: CustomTableInfo): TableSummary {
  return {
    name: table.name,
    scope: table.scope,
    usesWordPressPrefix: table.usesWordPressPrefix,
    ...(table.logicalName === undefined
      ? {}
      : { logicalName: table.logicalName }),
    ...(table.likelyOwner === undefined
      ? {}
      : { likelyOwner: table.likelyOwner }),
    ...(table.siteSpecific === undefined
      ? {}
      : { siteSpecific: table.siteSpecific }),
    ...(table.siteId === undefined ? {} : { siteId: table.siteId }),
    ...(table.engine === undefined ? {} : { engine: table.engine }),
    ...(table.collation === undefined ? {} : { collation: table.collation }),
    ...(table.rowCount === undefined ? {} : { rowCount: table.rowCount }),
    ...(table.sizeBytes === undefined ? {} : { sizeBytes: table.sizeBytes }),
  };
}

function group(tables: CustomTableInfo[]): Map<string, CustomTableInfo[]> {
  const groups = new Map<string, CustomTableInfo[]>();
  for (const table of [...tables].sort((a, b) => compareText(a.name, b.name))) {
    const key = identity(table).key;
    groups.set(key, [...(groups.get(key) ?? []), table]);
  }
  return groups;
}

export function compareCustomTables(
  source: CustomTableInfo[],
  target: CustomTableInfo[],
  findings: ComparisonFindings,
): CustomTableComparison {
  const left = group(source);
  const right = group(target);
  const result: CustomTableComparison = {
    sourceOnly: [],
    targetOnly: [],
    shared: [],
    ambiguous: [],
  };
  for (const key of sortedSet([...left.keys(), ...right.keys()])) {
    const a = left.get(key) ?? [];
    const b = right.get(key) ?? [];
    if (a.length > 1 || b.length > 1) {
      const ambiguity = {
        sourceNames: a.map((table) => table.name),
        targetNames: b.map((table) => table.name),
      };
      result.ambiguous.push(ambiguity);
      addFinding(findings, {
        code: 'CUSTOM_TABLE_MATCH_AMBIGUOUS',
        category: 'database',
        severity: 'warning',
        message:
          'Multiple tables share a comparison identity; no automatic pairing was selected.',
        details: ambiguity,
      });
      continue;
    }
    const first = a[0];
    const second = b[0];
    if (!first && second) result.targetOnly.push(summarize(second));
    else if (first && !second) {
      result.sourceOnly.push(summarize(first));
      addFinding(findings, {
        code: 'CUSTOM_TABLE_MISSING_ON_TARGET',
        category: 'database',
        severity:
          first.scope === 'site' && first.usesWordPressPrefix
            ? 'high'
            : 'warning',
        message:
          'A source custom table has no matching target table. Review its ownership and provisioning; a naming hint does not prove plugin installation.',
        details: {
          sourceName: first.name,
          scope: first.scope,
          ...(first.likelyOwner === undefined
            ? {}
            : { likelyOwner: first.likelyOwner }),
        },
      });
    } else if (first && second) {
      const metadata = compareFields(first, second, [
        'engine',
        'collation',
        'likelyOwner',
      ]);
      result.shared.push({
        source: summarize(first),
        target: summarize(second),
        matchingBasis: identity(first).basis,
        metadata,
      });
      if (Object.keys(metadata.differences).length)
        addFinding(findings, {
          code: 'CUSTOM_TABLE_METADATA_MISMATCH',
          category: 'database',
          severity: 'warning',
          message:
            'Matched table metadata differs. Storage compatibility and ownership require review; schemas have not been compared.',
          details: {
            sourceName: first.name,
            targetName: second.name,
            fields: Object.keys(metadata.differences),
          },
        });
    }
  }
  for (const [side, tables] of [
    ['source', source],
    ['target', target],
  ] as const) {
    const names = tables
      .filter((table) => table.scope !== 'site' || !table.usesWordPressPrefix)
      .map((table) => table.name)
      .sort(compareText);
    if (names.length)
      addFinding(findings, {
        code: 'CUSTOM_TABLE_SCOPE_UNVERIFIED',
        category: 'database',
        severity: 'warning',
        message:
          'Some tables have unverified cross-installation scope. Exact names or ambiguous network/main-site scope do not establish site ownership.',
        details: { side, names },
      });
  }
  result.sourceOnly.sort((a, b) => compareText(a.name, b.name));
  result.targetOnly.sort((a, b) => compareText(a.name, b.name));
  result.shared.sort(
    (a, b) =>
      compareText(a.source.name, b.source.name) ||
      compareText(a.target.name, b.target.name),
  );
  result.ambiguous.sort((a, b) =>
    compareText(JSON.stringify(a), JSON.stringify(b)),
  );
  return result;
}
