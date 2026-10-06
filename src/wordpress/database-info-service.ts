import type { WpCliClient } from './wp-cli-client.js';

export interface DatabaseInfo {
  databaseName: string;
  databaseHost: string;
  /** Active site's prefix, matching SiteInfo.tablePrefix. */
  tablePrefix: string;
  /** Visible base tables across the selected database; views are excluded. */
  tableCount: number;
  /** Existing current core tables for this installation and its multisite blogs. */
  coreTableCount: number;
  /** All remaining tables, including legacy/orphaned tables and other installations. */
  customTableCount: number;
  /** Metadata estimate of data plus index bytes, not disk usage or dump size. */
  sizeBytes?: number;
  /** Database schema defaults; individual tables may use different values. */
  charset?: string;
  collation?: string;
  multisite: boolean;
  siteCount?: number;
}

type DatabaseInfoClient = Pick<
  WpCliClient,
  'getDatabaseMetadata' | 'getSiteMetadata'
>;

export class DatabaseInfoService {
  constructor(private readonly client: DatabaseInfoClient) {}

  async getDatabaseInfo(): Promise<DatabaseInfo> {
    const [database, site] = await Promise.all([
      this.client.getDatabaseMetadata(),
      this.client.getSiteMetadata(),
    ]);
    const tables = new Set(database.tables);
    const coreTables = new Set(database.coreTables);
    const coreTableCount = [...tables].filter((table) =>
      coreTables.has(table),
    ).length;

    // Explicit projection prevents credentials or other adapter fields leaking out.
    return {
      databaseName: database.databaseName,
      databaseHost: database.databaseHost,
      tablePrefix: site.tablePrefix,
      tableCount: tables.size,
      coreTableCount,
      customTableCount: tables.size - coreTableCount,
      multisite: site.isMultisite,
      ...(database.sizeBytes === undefined
        ? {}
        : { sizeBytes: database.sizeBytes }),
      ...(database.charset === undefined ? {} : { charset: database.charset }),
      ...(database.collation === undefined
        ? {}
        : { collation: database.collation }),
      ...(site.isMultisite && database.siteCount !== undefined
        ? { siteCount: database.siteCount }
        : {}),
    };
  }
}
