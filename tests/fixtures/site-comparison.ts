import { vi } from 'vitest';
import type { SiteInfo } from '../../src/wordpress/site-info-service.js';
import type { DatabaseInfo } from '../../src/wordpress/database-info-service.js';
import type { ContentTypeInfo } from '../../src/migration/content-type-analyzer.js';
import type { TaxonomyInfo } from '../../src/migration/taxonomy-analyzer.js';
import type { CustomTableInfo } from '../../src/migration/custom-table-analyzer.js';
import type { UserAnalysis } from '../../src/migration/user-analyzer.js';
import type { MediaAnalysis } from '../../src/migration/media-analyzer.js';
import type { UrlReferenceAnalysis } from '../../src/migration/url-reference-analyzer.js';
import { SiteComparisonService } from '../../src/migration/site-comparison.js';
import { emptyReferenceMetadata } from './url-reference-metadata.js';

export interface Snapshot {
  site: SiteInfo;
  database: DatabaseInfo;
  contentTypes: ContentTypeInfo[];
  taxonomies: TaxonomyInfo[];
  customTables: CustomTableInfo[];
  users: UserAnalysis;
  media: MediaAnalysis;
  urls: UrlReferenceAnalysis;
}

export const contentType = (name = 'post'): ContentTypeInfo => ({
  name,
  public: true,
  publiclyQueryable: true,
  hierarchical: false,
  showUi: true,
  showInRest: true,
  hasArchive: false,
  builtIn: name === 'post',
  supports: ['title', 'editor'],
  postCount: 0,
});
export const taxonomy = (name = 'category'): TaxonomyInfo => ({
  name,
  public: true,
  publiclyQueryable: true,
  hierarchical: true,
  showUi: true,
  showInRest: true,
  builtIn: name === 'category',
  objectTypes: ['post'],
  termCount: 0,
});
export const table = (name = 'wp_events'): CustomTableInfo => ({
  name,
  logicalName: 'events',
  scope: 'site',
  usesWordPressPrefix: true,
  engine: 'InnoDB',
  collation: 'utf8mb4_unicode_ci',
  rowCount: 10,
  sizeBytes: 2048,
});

export function snapshot(): Snapshot {
  return {
    site: {
      wordpressVersion: '6.8',
      phpVersion: '8.3.0',
      wpCliVersion: '2.12.0',
      isMultisite: false,
      siteUrl: 'https://example.com',
      homeUrl: 'https://example.com',
      tablePrefix: 'wp_',
    },
    database: {
      databaseName: 'wordpress',
      databaseHost: 'localhost',
      tablePrefix: 'wp_',
      tableCount: 12,
      coreTableCount: 12,
      customTableCount: 0,
      multisite: false,
      charset: 'utf8mb4',
      collation: 'utf8mb4_unicode_ci',
    },
    contentTypes: [contentType()],
    taxonomies: [taxonomy()],
    customTables: [],
    users: {
      totalUsers: 0,
      multisite: false,
      roleSiteId: 1,
      siteUserCount: 0,
      administratorCount: 0,
      roleCounts: {},
      usersWithoutRole: 0,
      duplicateEmailCount: 0,
      duplicateLoginCount: 0,
      warnings: [],
    },
    media: {
      totalAttachments: 0,
      mimeTypeCounts: {},
      categoryCounts: {},
      missingAttachedFileMeta: 0,
      missingAttachmentMetadata: 0,
      unattachedAttachments: 0,
      orphanedAttachments: 0,
      externalMediaCount: 0,
      multisite: false,
      siteId: 1,
      warnings: [],
      uploadBaseDir: '/uploads',
      uploadBaseUrl: 'https://example.com/uploads',
      usesYearMonthFolders: true,
    },
    urls: {
      ...structuredClone(emptyReferenceMetadata),
      siteUrl: 'https://example.com',
      homeUrl: 'https://example.com',
      uploadBaseUrl: 'https://example.com/uploads',
      multisite: false,
      siteId: 1,
      warnings: [],
    },
  };
}

export function mockServices(data: Snapshot) {
  return {
    site: { getSiteInfo: vi.fn(async () => data.site) },
    database: { getDatabaseInfo: vi.fn(async () => data.database) },
    contentTypes: { analyze: vi.fn(async () => data.contentTypes) },
    taxonomies: { analyze: vi.fn(async () => data.taxonomies) },
    customTables: { analyze: vi.fn(async () => data.customTables) },
    users: { analyze: vi.fn(async () => data.users) },
    media: { analyze: vi.fn(async () => data.media) },
    urls: { analyze: vi.fn(async () => data.urls) },
  };
}

export const input = { sourcePath: '/source', targetPath: '/target' };
export function setup(source = snapshot(), target = snapshot()) {
  const left = mockServices(source);
  const right = mockServices(target);
  const factory = vi.fn((path: string) =>
    path === input.sourcePath ? left : right,
  );
  const service = new SiteComparisonService(factory);
  return {
    service,
    factory,
    left,
    right,
    source,
    target,
    compare: () => service.compare(input),
  };
}

export function calls(services: ReturnType<typeof mockServices>) {
  return [
    services.site.getSiteInfo,
    services.database.getDatabaseInfo,
    services.contentTypes.analyze,
    services.taxonomies.analyze,
    services.customTables.analyze,
    services.users.analyze,
    services.media.analyze,
    services.urls.analyze,
  ];
}
