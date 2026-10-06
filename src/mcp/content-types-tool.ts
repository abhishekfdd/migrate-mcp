import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ContentTypeAnalyzer } from '../migration/content-type-analyzer.js';
import { contentTypeMetadataSchema } from '../wordpress/content-type-metadata.js';
import { WpCliClient } from '../wordpress/wp-cli-client.js';
import { wordpressPathInputSchema, wpCliToolError } from './wp-cli-tool.js';

export type ContentTypeAnalyzerFactory = (
  path: string,
) => Pick<ContentTypeAnalyzer, 'analyze'>;

const contentTypesOutputSchema = z.object({
  contentTypes: z.array(
    contentTypeMetadataSchema.element.extend({
      // The adapter has already parsed counts; MCP output must contain numbers.
      postCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }),
  ),
});

export function registerContentTypesTool(
  server: McpServer,
  createAnalyzer: ContentTypeAnalyzerFactory = (path) =>
    new ContentTypeAnalyzer(new WpCliClient({ wordpressPath: path })),
): void {
  server.registerTool(
    'migration_list_content_types',
    {
      description:
        'List all registered WordPress post types, including built-in, internal, and custom types, with capabilities, REST configuration, and counts for a trusted local installation. Loads plugins and the active theme.',
      inputSchema: wordpressPathInputSchema,
      outputSchema: contentTypesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }): Promise<CallToolResult> => {
      try {
        const info = contentTypesOutputSchema.parse({
          contentTypes: await createAnalyzer(path).analyze(),
        });
        return {
          structuredContent: info,
          content: [{ type: 'text', text: JSON.stringify(info) }],
        };
      } catch (error) {
        return wpCliToolError(error, 'Content type information');
      }
    },
  );
}
