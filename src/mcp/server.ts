import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export function createServer(): McpServer {
  // This relative URL works from both src/mcp/ and dist/mcp/.
  const { version } = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version: string };

  const server = new McpServer({ name: 'wp-migrate-mcp', version });

  server.registerTool(
    'ping',
    {
      description: 'Internal connectivity check. Returns the server status.',
      inputSchema: z.strictObject({}),
      outputSchema: z.object({ status: z.literal('ok') }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () => {
      const result = { status: 'ok' as const };
      return {
        structuredContent: result,
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    },
  );

  return server;
}
