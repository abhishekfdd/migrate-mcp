import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import {
  registerSiteInfoTool,
  type SiteInfoServiceFactory,
} from './site-info-tool.js';

export function createServer(
  createSiteInfoService?: SiteInfoServiceFactory,
): McpServer {
  // This relative URL works from both src/mcp/ and dist/mcp/.
  const { version } = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version: string };

  const server = new McpServer({ name: 'wp-migrate-mcp', version });

  registerSiteInfoTool(server, createSiteInfoService);

  return server;
}
