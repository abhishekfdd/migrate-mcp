import type { SiteInfo } from '../wordpress/site-info-service.js';
import type { UrlReferenceAnalysis } from './url-reference-analyzer.js';
import {
  addFinding,
  analyzerWarnings,
  compareMetrics,
  compareValue,
  configuredHost,
  sortedSet,
  type ComparisonFindings,
} from './comparison-model.js';

export function compareUrls(
  source: UrlReferenceAnalysis,
  target: UrlReferenceAnalysis,
  targetSite: SiteInfo,
  findings: ComparisonFindings,
) {
  const targetHosts = sortedSet(
    [
      configuredHost(targetSite.siteUrl),
      configuredHost(targetSite.homeUrl),
    ].filter((host): host is string => host !== undefined),
  );
  const targetHostsInSource = targetHosts.map((host) => {
    const count = Object.hasOwn(source.hostCounts, host)
      ? source.hostCounts[host]
      : undefined;
    return {
      host,
      status:
        count !== undefined
          ? ('observed' as const)
          : source.unreportedHostReferences > 0
            ? ('unknown' as const)
            : ('not-observed' as const),
      ...(count === undefined ? {} : { count }),
    };
  });
  // These are observed set differences, not evidence of exclusive CDN ownership.
  const sourceOnlyObservedMediaHosts = sortedSet(
    Object.keys(source.externalMediaHostCounts),
  )
    .filter((host) => !Object.hasOwn(target.externalMediaHostCounts, host))
    .map((host) => ({
      host,
      referenceCount: source.externalMediaHostCounts[host]!,
    }));
  const uploadHost = compareValue(
    configuredHost(source.uploadBaseUrl),
    configuredHost(target.uploadBaseUrl),
  );
  if (source.sourceUrlReferences > 0 || source.filesystemPathReferences > 0)
    addFinding(findings, {
      code: 'SOURCE_ENVIRONMENT_REFERENCES_FOUND',
      category: 'url',
      severity: 'warning',
      message:
        'Source host references or filesystem path indicators need destination review. Path indicators do not establish that a path belongs to the source installation.',
      details: {
        hostnameReferences: source.sourceUrlReferences,
        filesystemPathReferences: source.filesystemPathReferences,
      },
    });
  for (const [side, analysis] of [
    ['source', source],
    ['target', target],
  ] as const) {
    if (analysis.developmentReferenceCount > 0)
      addFinding(findings, {
        code: 'DEVELOPMENT_URL_REFERENCES',
        category: 'url',
        severity: 'warning',
        message:
          'Development or local hostname indicators require review; their intended use is unknown.',
        details: { side, count: analysis.developmentReferenceCount },
      });
  }
  if (uploadHost.status === 'different')
    addFinding(findings, {
      code: 'UPLOAD_HOST_MISMATCH',
      category: 'url',
      severity: 'info',
      message:
        'Upload hostnames differ. Review media hosting dependencies before planning URL changes.',
    });
  // Preserve every analyzer warning, including scan limits; matching codes above add comparison context.
  analyzerWarnings(source.warnings, target.warnings, 'url', findings);
  return {
    targetHostsInSource,
    sourceOnlyObservedMediaHosts,
    uploadHost,
    metrics: compareMetrics(source, target, [
      'multisite',
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
    ]),
  };
}
