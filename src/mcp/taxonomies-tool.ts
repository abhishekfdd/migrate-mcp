import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { TaxonomyAnalyzer } from '../migration/taxonomy-analyzer.js';
import { taxonomyMetadataSchema } from '../wordpress/taxonomy-metadata.js';
import { WpCliClient } from '../wordpress/wp-cli-client.js';
import { wordpressPathInputSchema, wpCliToolError } from './wp-cli-tool.js';

export type TaxonomyAnalyzerFactory = (
  path: string,
) => Pick<TaxonomyAnalyzer, 'analyze'>;

const taxonomiesOutputSchema = z.object({
  taxonomies: z.array(
    taxonomyMetadataSchema.element.extend({
      // The adapter has already parsed counts; MCP output must contain numbers.
      termCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }),
  ),
});

export function registerTaxonomiesTool(
  server: McpServer,
  createAnalyzer: TaxonomyAnalyzerFactory = (path) =>
    new TaxonomyAnalyzer(new WpCliClient({ wordpressPath: path })),
): void {
  server.registerTool(
    'migration_list_taxonomies',
    {
      description:
        'List all registered WordPress taxonomies, including built-in, internal, and custom taxonomies, with associated object types, REST configuration, rewrite settings, and term counts for a trusted local installation. Loads plugins and the active theme.',
      inputSchema: wordpressPathInputSchema,
      outputSchema: taxonomiesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }): Promise<CallToolResult> => {
      try {
        const info = taxonomiesOutputSchema.parse({
          taxonomies: await createAnalyzer(path).analyze(),
        });
        return {
          structuredContent: info,
          content: [{ type: 'text', text: JSON.stringify(info) }],
        };
      } catch (error) {
        return wpCliToolError(error, 'Taxonomy information');
      }
    },
  );
}
