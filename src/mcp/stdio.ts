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

export function startStdioServer(
  transport: Transport = new StdioServerTransport(),
  createSiteInfoService?: SiteInfoServiceFactory,
  createDatabaseInfoService?: DatabaseInfoServiceFactory,
  createContentTypeAnalyzer?: ContentTypeAnalyzerFactory,
): StdioServerHandle {
  return serveStdio(
    () =>
      createServer(
        createSiteInfoService,
        createDatabaseInfoService,
        createContentTypeAnalyzer,
      ),
    {
      transport,
      onerror: (error) => {
        // stdout is reserved for MCP protocol messages.
        process.stderr.write(`wp-migrate-mcp: ${error.message}\n`);
      },
    },
  );
}
