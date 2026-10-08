import type { WpCliClient } from '../wordpress/wp-cli-client.js';
import type { WpUrlReferenceMetadata } from '../wordpress/url-reference-metadata.js';

export interface UrlReferenceWarning {
  code: string;
  message: string;
  count?: number;
}

/** Counts are occurrences, not unique URLs or matching row counts. */
export interface UrlReferenceAnalysis extends Omit<
  WpUrlReferenceMetadata,
  'siteUrl' | 'homeUrl' | 'uploadBaseUrl'
> {
  siteUrl?: string;
  homeUrl?: string;
  uploadBaseUrl?: string;
  warnings: UrlReferenceWarning[];
}

export class UrlReferenceAnalyzer {
  constructor(
    private readonly client: Pick<WpCliClient, 'getUrlReferenceMetadata'>,
  ) {}

  async analyze(): Promise<UrlReferenceAnalysis> {
    const data = await this.client.getUrlReferenceMetadata();
    const warnings: UrlReferenceWarning[] = [];
    const warn = (code: string, message: string, count: number) => {
      if (count > 0) warnings.push({ code, message, count });
    };
    warn(
      'HTTP_REFERENCES_FOUND',
      'Plain HTTP references may need review for the destination environment.',
      data.httpReferences,
    );
    warn(
      'SOURCE_DOMAIN_REFERENCES_FOUND',
      'References use the configured site or home hostname; review them when planning a domain change.',
      data.sourceUrlReferences,
    );
    warn(
      'DEVELOPMENT_URL_REFERENCES',
      'Local or development hostname indicators were found; their intended use is not verified.',
      data.developmentReferenceCount,
    );
    warn(
      'SERIALIZED_URL_REFERENCES',
      'Likely PHP serialized values contain URLs. Future changes must preserve serialization lengths.',
      data.serializedValueReferences,
    );
    warn(
      'FILESYSTEM_PATH_REFERENCES',
      'Absolute filesystem path indicators were found; paths were not accessed or returned.',
      data.filesystemPathReferences,
    );
    warn(
      'EXTERNAL_MEDIA_HOSTS',
      'External media/CDN indicators were found; external hosting is not itself a migration problem.',
      data.externalMediaReferences,
    );
    warn(
      'MALFORMED_URL_REFERENCES',
      'Malformed or unsupported URL-like tokens were skipped.',
      data.malformedUrlReferences,
    );
    warn(
      'HOST_SUMMARY_LIMIT',
      'The host summary limit was reached; these occurrences remain in totals but are absent from host maps.',
      data.unreportedHostReferences,
    );
    warn(
      'OVERSIZED_VALUES_SKIPPED',
      'Text values larger than 64 KiB were skipped; reference totals are incomplete.',
      data.skippedOversizedValues,
    );
    warn(
      'BINARY_VALUES_SKIPPED',
      'Values containing NUL bytes or invalid UTF-8 were skipped.',
      data.skippedBinaryValues,
    );
    warn(
      'SENSITIVE_VALUES_EXCLUDED',
      'Secret-keyed values, transient entries, or sensitive JSON fields were excluded.',
      data.skippedSensitiveValues,
    );
    if (
      data.siteUrl === undefined ||
      data.homeUrl === undefined ||
      data.uploadBaseUrl === undefined
    ) {
      warnings.push({
        code: 'REFERENCE_CONFIGURATION_UNAVAILABLE',
        message:
          'Some site/home/upload URL configuration was unavailable or unsupported; related counts may be incomplete.',
      });
    }
    const ordered = (counts: Record<string, number>) =>
      Object.fromEntries(
        Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    return {
      ...(data.siteUrl === undefined ? {} : { siteUrl: data.siteUrl }),
      ...(data.homeUrl === undefined ? {} : { homeUrl: data.homeUrl }),
      ...(data.uploadBaseUrl === undefined
        ? {}
        : { uploadBaseUrl: data.uploadBaseUrl }),
      multisite: data.multisite,
      siteId: data.siteId,
      totalReferences: data.totalReferences,
      hostCounts: ordered(data.hostCounts),
      sourceUrlReferences: data.sourceUrlReferences,
      externalUrlReferences: data.externalUrlReferences,
      httpReferences: data.httpReferences,
      httpsReferences: data.httpsReferences,
      protocolRelativeReferences: data.protocolRelativeReferences,
      siteUrlReferences: data.siteUrlReferences,
      homeUrlReferences: data.homeUrlReferences,
      uploadUrlReferences: data.uploadUrlReferences,
      alternateSourceHosts: [...data.alternateSourceHosts].sort(),
      externalMediaHostCounts: ordered(data.externalMediaHostCounts),
      externalMediaReferences: data.externalMediaReferences,
      serializedValueReferences: data.serializedValueReferences,
      jsonValueReferences: data.jsonValueReferences,
      filesystemPathReferences: data.filesystemPathReferences,
      developmentReferenceCount: data.developmentReferenceCount,
      malformedUrlReferences: data.malformedUrlReferences,
      unreportedHostReferences: data.unreportedHostReferences,
      scannedValues: data.scannedValues,
      skippedSensitiveValues: data.skippedSensitiveValues,
      skippedOversizedValues: data.skippedOversizedValues,
      skippedBinaryValues: data.skippedBinaryValues,
      locations: data.locations
        .map(({ source, referenceCount }) => ({ source, referenceCount }))
        .sort((a, b) =>
          a.source < b.source ? -1 : a.source > b.source ? 1 : 0,
        ),
      warnings: warnings.sort((a, b) =>
        a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
      ),
    };
  }
}
