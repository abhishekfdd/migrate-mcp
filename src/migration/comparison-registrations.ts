import type { ContentTypeInfo } from './content-type-analyzer.js';
import type { TaxonomyInfo } from './taxonomy-analyzer.js';
import {
  addFinding,
  compareFields,
  compareText,
  sortedSet,
  type ComparisonFindings,
  type ValueComparison,
} from './comparison-model.js';

export interface RegistrationComparison {
  sourceOnly: string[];
  targetOnly: string[];
  shared: string[];
  changed: { name: string; differences: Record<string, ValueComparison> }[];
  unavailable: { name: string; fields: Record<string, ValueComparison> }[];
  volumes: { name: string; source?: number; target?: number }[];
}

function compareRegistrations<T extends { name: string }>(
  source: T[],
  target: T[],
  fields: readonly (keyof T & string)[],
  volume: (item: T) => number,
): RegistrationComparison {
  const left = new Map(source.map((item) => [item.name, item]));
  const right = new Map(target.map((item) => [item.name, item]));
  const result: RegistrationComparison = {
    sourceOnly: [],
    targetOnly: [],
    shared: [],
    changed: [],
    unavailable: [],
    volumes: [],
  };
  for (const name of sortedSet([...left.keys(), ...right.keys()])) {
    const a = left.get(name);
    const b = right.get(name);
    result.volumes.push({
      name,
      ...(a ? { source: volume(a) } : {}),
      ...(b ? { target: volume(b) } : {}),
    });
    if (!a) result.targetOnly.push(name);
    else if (!b) result.sourceOnly.push(name);
    else {
      result.shared.push(name);
      const { differences, unavailable } = compareFields(a, b, fields);
      if (Object.keys(differences).length)
        result.changed.push({ name, differences });
      if (Object.keys(unavailable).length)
        result.unavailable.push({ name, fields: unavailable });
    }
  }
  return result;
}

function registrationFindings(
  result: RegistrationComparison,
  category: 'content-type' | 'taxonomy',
  findings: ComparisonFindings,
): void {
  const code = category === 'content-type' ? 'CONTENT_TYPE' : 'TAXONOMY';
  for (const name of result.sourceOnly)
    addFinding(findings, {
      code: `${code}_MISSING_ON_TARGET`,
      severity: 'high',
      category,
      message:
        'A source registration is missing on the target. Review required registration code before migrating its data.',
      details: { name },
    });
  for (const change of result.changed)
    addFinding(findings, {
      code: `${code}_CONFIGURATION_MISMATCH`,
      severity: 'warning',
      category,
      message: 'Shared registration settings differ and should be reviewed.',
      details: {
        name: change.name,
        fields: Object.keys(change.differences).sort(compareText),
      },
    });
}

export function compareContentTypes(
  source: ContentTypeInfo[],
  target: ContentTypeInfo[],
  findings: ComparisonFindings,
): RegistrationComparison {
  const normalize = (types: ContentTypeInfo[]) =>
    types.map((type) => ({ ...type, supports: sortedSet(type.supports) }));
  const result = compareRegistrations(
    normalize(source),
    normalize(target),
    [
      'hierarchical',
      'public',
      'publiclyQueryable',
      'showUi',
      'showInRest',
      'restBase',
      'rewriteSlug',
      'capabilityType',
      'supports',
      'hasArchive',
      'builtIn',
    ],
    (type) => type.postCount,
  );
  registrationFindings(result, 'content-type', findings);
  return result;
}

export function compareTaxonomies(
  source: TaxonomyInfo[],
  target: TaxonomyInfo[],
  findings: ComparisonFindings,
): RegistrationComparison {
  const normalize = (types: TaxonomyInfo[]) =>
    types.map((type) => ({
      ...type,
      objectTypes: sortedSet(type.objectTypes),
    }));
  const result = compareRegistrations(
    normalize(source),
    normalize(target),
    [
      'hierarchical',
      'public',
      'publiclyQueryable',
      'showUi',
      'showInRest',
      'restBase',
      'rewriteSlug',
      'objectTypes',
      'builtIn',
    ],
    (type) => type.termCount,
  );
  registrationFindings(result, 'taxonomy', findings);
  return result;
}
