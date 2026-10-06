import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { DatabaseInfoService } from '../wordpress/database-info-service.js';
import { WpCliClient } from '../wordpress/wp-cli-client.js';
import { wordpressPathInputSchema, wpCliToolError } from './wp-cli-tool.js';

export type DatabaseInfoServiceFactory = (
  path: string,
) => Pick<DatabaseInfoService, 'getDatabaseInfo'>;

const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const databaseInfoOutputSchema = z.object({
  databaseName: z.string(),
  databaseHost: z.string(),
  tablePrefix: z.string(),
  tableCount: countSchema,
  coreTableCount: countSchema,
  customTableCount: countSchema,
  sizeBytes: countSchema.optional(),
  charset: z.string().optional(),
  collation: z.string().optional(),
  multisite: z.boolean(),
  siteCount: countSchema.optional(),
});

export function registerDatabaseInfoTool(
  server: McpServer,
  createService: DatabaseInfoServiceFactory = (path) =>
    new DatabaseInfoService(new WpCliClient({ wordpressPath: path })),
): void {
  server.registerTool(
    'migration_database_info',
    {
      description:
        'Read database metadata for a trusted local WordPress installation using WP-CLI. Does not return credentials.',
      inputSchema: wordpressPathInputSchema,
      outputSchema: databaseInfoOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }): Promise<CallToolResult> => {
      try {
        // Parse before serializing: strip unknown fields and never coerce numbers.
        const info = databaseInfoOutputSchema.parse(
          await createService(path).getDatabaseInfo(),
        );
        return {
          structuredContent: info,
          content: [{ type: 'text', text: JSON.stringify(info) }],
        };
      } catch (error) {
        return wpCliToolError(error, 'Database information');
      }
    },
  );
}
