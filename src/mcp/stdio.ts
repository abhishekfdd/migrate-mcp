import type { Transport } from '@modelcontextprotocol/server';
import {
  serveStdio,
  StdioServerTransport,
  type StdioServerHandle,
} from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';
import type { SiteInfoServiceFactory } from './site-info-tool.js';
import type { DatabaseInfoServiceFactory } from './database-info-tool.js';
import type { ContentTypeAnalyzerFactory } from './content-types-tool.js';
import type { TaxonomyAnalyzerFactory } from './taxonomies-tool.js';
import type { CustomTableAnalyzerFactory } from './custom-tables-tool.js';
import type { UserAnalyzerFactory } from './users-tool.js';
import type { MediaAnalyzerFactory } from './media-tool.js';
import type { UrlReferenceAnalyzerFactory } from './urls-tool.js';
import type { SiteComparisonServiceFactory } from './compare-sites-tool.js';
import type { MigrationPlannerFactory } from './generate-plan-tool.js';

export function startStdioServer(
  transport: Transport = new StdioServerTransport(),
  createSiteInfoService?: SiteInfoServiceFactory,
  createDatabaseInfoService?: DatabaseInfoServiceFactory,
  createContentTypeAnalyzer?: ContentTypeAnalyzerFactory,
  createTaxonomyAnalyzer?: TaxonomyAnalyzerFactory,
  createCustomTableAnalyzer?: CustomTableAnalyzerFactory,
  createUserAnalyzer?: UserAnalyzerFactory,
  createMediaAnalyzer?: MediaAnalyzerFactory,
  createUrlReferenceAnalyzer?: UrlReferenceAnalyzerFactory,
  createSiteComparisonService?: SiteComparisonServiceFactory,
  createMigrationPlanner?: MigrationPlannerFactory,
): StdioServerHandle {
  return serveStdio(
    () =>
      createServer(
        createSiteInfoService,
        createDatabaseInfoService,
        createContentTypeAnalyzer,
        createTaxonomyAnalyzer,
        createCustomTableAnalyzer,
        createUserAnalyzer,
        createMediaAnalyzer,
        createUrlReferenceAnalyzer,
        createSiteComparisonService,
        createMigrationPlanner,
      ),
    {
      transport,
      onerror: (error) => {
        // stdout is reserved for MCP protocol messages.
        process.stderr.write(`migrate-mcp: ${error.message}\n`);
      },
    },
  );
}
