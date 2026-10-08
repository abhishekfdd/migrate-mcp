import type { SiteInfo } from '../wordpress/site-info-service.js';
import type { DatabaseInfo } from '../wordpress/database-info-service.js';
import {
  addFinding,
  compareFields,
  compareMetrics,
  compareValue,
  publicSiteUrl,
  type ComparisonFindings,
} from './comparison-model.js';

export function siteIdentity(path: string, site: SiteInfo) {
  return {
    path,
    siteUrl: publicSiteUrl(site.siteUrl),
    homeUrl: publicSiteUrl(site.homeUrl),
    wordpressVersion: site.wordpressVersion,
    multisite: site.isMultisite,
    tablePrefix: site.tablePrefix,
  };
}

export function compareEnvironment(
  source: SiteInfo,
  target: SiteInfo,
  findings: ComparisonFindings,
) {
  const result = {
    wordpressVersion: compareValue(
      source.wordpressVersion,
      target.wordpressVersion,
    ),
    phpVersion: compareValue(source.phpVersion, target.phpVersion),
    multisite: compareValue(source.isMultisite, target.isMultisite),
  };
  for (const component of ['wordpressVersion', 'phpVersion'] as const) {
    if (result[component].status === 'different')
      addFinding(findings, {
        code: 'VERSION_DIFFERENCE',
        severity: 'warning',
        category: 'environment',
        message:
          'Runtime versions differ. Compatibility requires review; version equality alone does not establish compatibility.',
        details: { component },
      });
  }
  if (result.multisite.status === 'different')
    addFinding(findings, {
      code: 'MULTISITE_MODE_MISMATCH',
      severity: 'blocking',
      category: 'environment',
      message:
        'Source and target use different single-site/multisite modes. A direct migration requires an explicit topology conversion strategy.',
      details: { source: source.isMultisite, target: target.isMultisite },
    });
  return result;
}

export function compareDatabase(
  source: DatabaseInfo,
  target: DatabaseInfo,
  findings: ComparisonFindings,
) {
  const configuration = compareFields(source, target, ['charset', 'collation']);
  if (Object.keys(configuration.differences).length)
    addFinding(findings, {
      code: 'DATABASE_CONFIGURATION_MISMATCH',
      category: 'database',
      severity: 'warning',
      message:
        'Database charset or collation defaults differ; assess data compatibility separately from individual table settings.',
      details: { fields: Object.keys(configuration.differences) },
    });
  return {
    configuration,
    metrics: compareMetrics(source, target, [
      'tableCount',
      'coreTableCount',
      'customTableCount',
      'sizeBytes',
      'siteCount',
      'multisite',
      'tablePrefix',
    ]),
  };
}
