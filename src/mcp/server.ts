import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import {
  registerContentTypesTool,
  type ContentTypeAnalyzerFactory,
} from './content-types-tool.js';
import {
  registerDatabaseInfoTool,
  type DatabaseInfoServiceFactory,
} from './database-info-tool.js';
import {
  registerSiteInfoTool,
  type SiteInfoServiceFactory,
} from './site-info-tool.js';
import {
  registerTaxonomiesTool,
  type TaxonomyAnalyzerFactory,
} from './taxonomies-tool.js';
import {
  registerCustomTablesTool,
  type CustomTableAnalyzerFactory,
} from './custom-tables-tool.js';

export function createServer(
  createSiteInfoService?: SiteInfoServiceFactory,
  createDatabaseInfoService?: DatabaseInfoServiceFactory,
  createContentTypeAnalyzer?: ContentTypeAnalyzerFactory,
  createTaxonomyAnalyzer?: TaxonomyAnalyzerFactory,
  createCustomTableAnalyzer?: CustomTableAnalyzerFactory,
): McpServer {
  // This relative URL works from both src/mcp/ and dist/mcp/.
  const { version } = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version: string };

  const server = new McpServer({ name: 'wp-migrate-mcp', version });

  registerSiteInfoTool(server, createSiteInfoService);
  registerDatabaseInfoTool(server, createDatabaseInfoService);
  registerContentTypesTool(server, createContentTypeAnalyzer);
  registerTaxonomiesTool(server, createTaxonomyAnalyzer);
  registerCustomTablesTool(server, createCustomTableAnalyzer);

  return server;
}
