import { isAbsolute } from 'node:path';
import { WpCliClient } from '../wordpress/wp-cli-client.js';
import { SiteInfoService } from '../wordpress/site-info-service.js';
import { DatabaseInfoService } from '../wordpress/database-info-service.js';
import { ContentTypeAnalyzer } from './content-type-analyzer.js';
import { TaxonomyAnalyzer } from './taxonomy-analyzer.js';
import { CustomTableAnalyzer } from './custom-table-analyzer.js';
import { UserAnalyzer } from './user-analyzer.js';
import { MediaAnalyzer } from './media-analyzer.js';
import { UrlReferenceAnalyzer } from './url-reference-analyzer.js';
import { sortFindings, type ComparisonFindings } from './comparison-model.js';
import {
  compareEnvironment,
  compareDatabase,
  siteIdentity,
} from './comparison-environment.js';
import {
  compareContentTypes,
  compareTaxonomies,
} from './comparison-registrations.js';
import { compareCustomTables } from './comparison-tables.js';
import { compareUsers, compareMedia } from './comparison-users-media.js';
import { compareUrls } from './comparison-urls.js';

export interface SiteComparisonInput {
  sourcePath: string;
  targetPath: string;
}

export interface SiteComparisonServices {
  site: Pick<SiteInfoService, 'getSiteInfo'>;
  database: Pick<DatabaseInfoService, 'getDatabaseInfo'>;
  contentTypes: Pick<ContentTypeAnalyzer, 'analyze'>;
  taxonomies: Pick<TaxonomyAnalyzer, 'analyze'>;
  customTables: Pick<CustomTableAnalyzer, 'analyze'>;
  users: Pick<UserAnalyzer, 'analyze'>;
  media: Pick<MediaAnalyzer, 'analyze'>;
  urls: Pick<UrlReferenceAnalyzer, 'analyze'>;
}

export interface SiteComparison extends ComparisonFindings {
  source: ReturnType<typeof siteIdentity>;
  target: ReturnType<typeof siteIdentity>;
  compatibility: ReturnType<typeof compareEnvironment>;
  database: ReturnType<typeof compareDatabase>;
  contentTypes: ReturnType<typeof compareContentTypes>;
  taxonomies: ReturnType<typeof compareTaxonomies>;
  customTables: ReturnType<typeof compareCustomTables>;
  users: ReturnType<typeof compareUsers>;
  media: ReturnType<typeof compareMedia>;
  urlReferences: ReturnType<typeof compareUrls>;
  summary: {
    conflictCount: number;
    warningCount: number;
    blockingConflictCount: number;
  };
}

function createServices(path: string): SiteComparisonServices {
  const client = new WpCliClient({ wordpressPath: path });
  return {
    site: new SiteInfoService(client),
    database: new DatabaseInfoService(client),
    contentTypes: new ContentTypeAnalyzer(client),
    taxonomies: new TaxonomyAnalyzer(client),
    customTables: new CustomTableAnalyzer(client),
    users: new UserAnalyzer(client),
    media: new MediaAnalyzer(client),
    urls: new UrlReferenceAnalyzer(client),
  };
}

/** Wait for both sides before throwing; source failure wins if both fail. */
async function pair<T>(
  source: () => Promise<T>,
  target: () => Promise<T>,
): Promise<[T, T]> {
  const [left, right] = await Promise.allSettled([
    Promise.resolve().then(source),
    Promise.resolve().then(target),
  ]);
  if (left.status === 'rejected') throw left.reason;
  if (right.status === 'rejected') throw right.reason;
  return [left.value, right.value];
}

export class SiteComparisonService {
  constructor(
    private readonly servicesForPath: (
      path: string,
    ) => SiteComparisonServices = createServices,
  ) {}

  async compare(input: SiteComparisonInput): Promise<SiteComparison> {
    for (const path of [input.sourcePath, input.targetPath]) {
      if (
        typeof path !== 'string' ||
        !path.trim() ||
        path.includes('\0') ||
        !isAbsolute(path)
      ) {
        throw new TypeError(
          'Source and target paths must be non-empty absolute paths without NUL bytes.',
        );
      }
    }
    const source = this.servicesForPath(input.sourcePath);
    const target = this.servicesForPath(input.targetPath);
    // At most one service per side is running. Existing services may internally
    // parallelize WP-CLI calls; no discovery or process execution is added here.
    const sites = await pair(
      () => source.site.getSiteInfo(),
      () => target.site.getSiteInfo(),
    );
    const databases = await pair(
      () => source.database.getDatabaseInfo(),
      () => target.database.getDatabaseInfo(),
    );
    const types = await pair(
      () => source.contentTypes.analyze(),
      () => target.contentTypes.analyze(),
    );
    const taxonomies = await pair(
      () => source.taxonomies.analyze(),
      () => target.taxonomies.analyze(),
    );
    const tables = await pair(
      () => source.customTables.analyze(),
      () => target.customTables.analyze(),
    );
    const users = await pair(
      () => source.users.analyze(),
      () => target.users.analyze(),
    );
    const media = await pair(
      () => source.media.analyze(),
      () => target.media.analyze(),
    );
    const urls = await pair(
      () => source.urls.analyze(),
      () => target.urls.analyze(),
    );
    const findings: ComparisonFindings = { conflicts: [], warnings: [] };
    const result = {
      source: siteIdentity(input.sourcePath, sites[0]),
      target: siteIdentity(input.targetPath, sites[1]),
      compatibility: compareEnvironment(...sites, findings),
      database: compareDatabase(...databases, findings),
      contentTypes: compareContentTypes(...types, findings),
      taxonomies: compareTaxonomies(...taxonomies, findings),
      customTables: compareCustomTables(...tables, findings),
      users: compareUsers(...users, findings),
      media: compareMedia(...media, findings),
      urlReferences: compareUrls(...urls, sites[1], findings),
    };
    sortFindings(findings);
    return {
      ...result,
      ...findings,
      summary: {
        conflictCount: findings.conflicts.length,
        warningCount: findings.warnings.length,
        blockingConflictCount: findings.conflicts.filter(
          ({ severity }) => severity === 'blocking',
        ).length,
      },
    };
  }
}
