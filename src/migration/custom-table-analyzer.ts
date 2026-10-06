import type { WpTableMetadata } from '../wordpress/table-metadata.js';
import type { WpCliClient } from '../wordpress/wp-cli-client.js';

const referenceTargets = {
  post_id: 'posts',
  user_id: 'users',
  term_id: 'terms',
  comment_id: 'comments',
  blog_id: 'blogs',
  site_id: 'site',
} as const;

export interface CustomTableInfo {
  name: string;
  logicalName?: string;
  /** Database metadata estimate; no exact row count is performed. */
  rowCount?: number;
  /** Data plus index metadata estimate, not disk usage or export size. */
  sizeBytes?: number;
  dataSizeBytes?: number;
  indexSizeBytes?: number;
  engine?: string;
  collation?: string;
  /** Literal match against the active site's prefix, not the network base prefix. */
  usesWordPressPrefix: boolean;
  /** Naming hint only; does not prove plugin installation or ownership. */
  likelyOwner?: string;
  scope: 'site' | 'network-or-main-site' | 'unprefixed' | 'unknown';
  /** Present only when a registered site's distinct prefix provides evidence. */
  siteSpecific?: boolean;
  siteId?: number;
  /** Column-name hints, not verified foreign keys or relationship targets. */
  referenceHints?: {
    column: string;
    possibleTarget: (typeof referenceTargets)[keyof typeof referenceTargets];
  }[];
}

function tableContext(
  name: string,
  metadata: WpTableMetadata,
  sitesByPrefix: Map<string, number>,
): Pick<CustomTableInfo, 'logicalName' | 'scope' | 'siteSpecific' | 'siteId'> {
  const { basePrefix, multisite } = metadata;
  if (!name.startsWith(basePrefix)) return { scope: 'unprefixed' };
  const logicalName = name.slice(basePrefix.length);
  if (multisite) {
    const numberedPrefix = logicalName.match(/^\d+_/);
    if (numberedPrefix) {
      const siteId = sitesByPrefix.get(basePrefix + numberedPrefix[0]);
      if (siteId !== undefined) {
        return {
          logicalName: logicalName.slice(numberedPrefix[0].length),
          scope: 'site',
          siteSpecific: true,
          siteId,
        };
      }
      return { logicalName, scope: 'unknown' };
    }
    return {
      logicalName,
      scope: basePrefix ? 'network-or-main-site' : 'unknown',
    };
  }
  const siteId = sitesByPrefix.get(basePrefix);
  return basePrefix && siteId !== undefined
    ? { logicalName, scope: 'site', siteSpecific: true, siteId }
    : { logicalName, scope: 'unknown' };
}

function inferOwner(logicalName: string | undefined): string | undefined {
  if (logicalName?.startsWith('actionscheduler_')) return 'Action Scheduler';
  if (logicalName?.startsWith('gf_')) return 'Gravity Forms';
  if (logicalName?.startsWith('woocommerce_')) return 'WooCommerce';
  return undefined;
}

export class CustomTableAnalyzer {
  constructor(private readonly client: Pick<WpCliClient, 'getTableMetadata'>) {}

  async analyze(): Promise<CustomTableInfo[]> {
    const metadata = await this.client.getTableMetadata();
    const coreTables = new Set(metadata.coreTables);
    const sitesByPrefix = new Map(
      metadata.sites.map((site) => [site.prefix, site.id]),
    );
    return metadata.tables
      .filter((table) => !coreTables.has(table.name))
      .map((table): CustomTableInfo => {
        const context = tableContext(table.name, metadata, sitesByPrefix);
        const likelyOwner = inferOwner(context.logicalName);
        const info: CustomTableInfo = {
          name: table.name,
          usesWordPressPrefix: table.name.startsWith(metadata.tablePrefix),
          ...context,
          ...(likelyOwner === undefined ? {} : { likelyOwner }),
        };
        // Explicit projection keeps internal metadata and unexpected fields out.
        for (const key of [
          'rowCount',
          'sizeBytes',
          'dataSizeBytes',
          'indexSizeBytes',
        ] as const) {
          if (table[key] !== undefined) info[key] = table[key];
        }
        for (const key of ['engine', 'collation'] as const) {
          if (table[key] !== undefined) info[key] = table[key];
        }
        if (table.referenceColumns !== undefined) {
          info.referenceHints = [...table.referenceColumns]
            .sort()
            .flatMap((column) => {
              const key = column.toLowerCase();
              return Object.hasOwn(referenceTargets, key)
                ? [
                    {
                      column,
                      possibleTarget:
                        referenceTargets[key as keyof typeof referenceTargets],
                    },
                  ]
                : [];
            });
        }
        return info;
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
}
