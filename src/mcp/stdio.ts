import type { Transport } from '@modelcontextprotocol/server';
import {
  serveStdio,
  StdioServerTransport,
  type StdioServerHandle,
} from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';

export function startStdioServer(
  transport: Transport = new StdioServerTransport(),
): StdioServerHandle {
  return serveStdio(createServer, {
    transport,
    onerror: (error) => {
      // stdout is reserved for MCP protocol messages.
      process.stderr.write(`wp-migrate-mcp: ${error.message}\n`);
    },
  });
}
