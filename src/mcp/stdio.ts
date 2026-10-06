import type { Transport } from '@modelcontextprotocol/server';
import {
  serveStdio,
  StdioServerTransport,
  type StdioServerHandle,
} from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';
import type { SiteInfoServiceFactory } from './site-info-tool.js';

export function startStdioServer(
  transport: Transport = new StdioServerTransport(),
  createSiteInfoService?: SiteInfoServiceFactory,
): StdioServerHandle {
  return serveStdio(() => createServer(createSiteInfoService), {
    transport,
    onerror: (error) => {
      // stdout is reserved for MCP protocol messages.
      process.stderr.write(`wp-migrate-mcp: ${error.message}\n`);
    },
  });
}
