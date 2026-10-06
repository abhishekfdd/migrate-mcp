import type { WpCliClient } from './wp-cli-client.js';

export interface SiteInfo {
  wordpressVersion: string;
  isMultisite: boolean;
  siteUrl: string;
  homeUrl: string;
  /** Prefix of the active site's tables; on multisite it may include a blog ID. */
  tablePrefix: string;
  /** PHP runtime used by WP-CLI, which may differ from the web server's runtime. */
  phpVersion: string;
  wpCliVersion: string;
}

type SiteInfoClient = Pick<
  WpCliClient,
  'getCoreVersion' | 'getCliInfo' | 'getSiteMetadata'
>;

export class SiteInfoService {
  constructor(private readonly client: SiteInfoClient) {}

  async getSiteInfo(): Promise<SiteInfo> {
    const [core, cli, site] = await Promise.all([
      this.client.getCoreVersion(),
      this.client.getCliInfo(),
      this.client.getSiteMetadata(),
    ]);

    return {
      wordpressVersion: core.version,
      isMultisite: site.isMultisite,
      siteUrl: site.siteUrl,
      homeUrl: site.homeUrl,
      tablePrefix: site.tablePrefix,
      phpVersion: cli.php_version,
      wpCliVersion: cli.wp_cli_version,
    };
  }
}
