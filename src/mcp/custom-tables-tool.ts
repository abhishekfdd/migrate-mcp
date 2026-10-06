import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  CustomTableAnalyzer,
  type CustomTableInfo,
} from '../migration/custom-table-analyzer.js';
import { WpCliClient } from '../wordpress/wp-cli-client.js';
import { wordpressPathInputSchema, wpCliToolError } from './wp-cli-tool.js';

export type CustomTableAnalyzerFactory = (
  path: string,
) => Pick<CustomTableAnalyzer, 'analyze'>;

const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const customTableOutputSchema = z.object({
  name: z.string().min(1),
  logicalName: z.string().optional(),
  rowCount: countSchema.optional(),
  sizeBytes: countSchema.optional(),
  dataSizeBytes: countSchema.optional(),
  indexSizeBytes: countSchema.optional(),
  engine: z.string().optional(),
  collation: z.string().optional(),
  usesWordPressPrefix: z.boolean(),
  likelyOwner: z.string().optional(),
  scope: z.enum(['site', 'network-or-main-site', 'unprefixed', 'unknown']),
  siteSpecific: z.boolean().optional(),
  siteId: countSchema.positive().optional(),
  referenceHints: z
    .array(
      z.object({
        column: z.string(),
        possibleTarget: z.enum([
          'posts',
          'users',
          'terms',
          'comments',
          'blogs',
          'site',
        ]),
      }),
    )
    .optional(),
} satisfies {
  [Key in keyof Required<CustomTableInfo>]: z.ZodType<CustomTableInfo[Key]>;
});

const customTablesOutputSchema = z.object({
  customTables: z.array(customTableOutputSchema),
});

export function registerCustomTablesTool(
  server: McpServer,
  createAnalyzer: CustomTableAnalyzerFactory = (path) =>
    new CustomTableAnalyzer(new WpCliClient({ wordpressPath: path })),
): void {
  server.registerTool(
    'migration_list_custom_tables',
    {
      description:
        'List non-core database tables for a trusted local WordPress installation, with estimated row counts and sizes, multisite scope, and conservative ownership and reference hints. Does not return credentials.',
      inputSchema: wordpressPathInputSchema,
      outputSchema: customTablesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }): Promise<CallToolResult> => {
      try {
        // Validate the domain shape and strip unexpected fields before serialization.
        const info = customTablesOutputSchema.parse({
          customTables: await createAnalyzer(path).analyze(),
        });
        return {
          structuredContent: info,
          content: [{ type: 'text', text: JSON.stringify(info) }],
        };
      } catch (error) {
        return wpCliToolError(error, 'Custom table information');
      }
    },
  );
}
