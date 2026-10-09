import { resolve } from 'node:path';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { SiteComparisonService } from '../migration/site-comparison.js';
import { siteComparisonOutputSchema } from './compare-sites-schema.js';
import { wordpressPathInputSchema, wpCliToolError } from './wp-cli-tool.js';

export type SiteComparisonServiceFactory = () => Pick<
  SiteComparisonService,
  'compare'
>;

export const comparisonInputSchema = z.strictObject({
  sourcePath: wordpressPathInputSchema.shape.path.describe(
    'Absolute path to the source WordPress installation on the MCP server host.',
  ),
  targetPath: wordpressPathInputSchema.shape.path.describe(
    'Absolute path to the target WordPress installation on the MCP server host.',
  ),
});

export function registerCompareSitesTool(
  server: McpServer,
  createService: SiteComparisonServiceFactory = () =>
    new SiteComparisonService(),
): void {
  server.registerTool(
    'migration_compare_sites',
    {
      description:
        'Compare two trusted local WordPress installations for migration-relevant configuration differences, custom tables, user ID risks, media issues, and URL dependencies. Returns read-only summaries and findings; does not generate a plan or execute migration changes.',
      inputSchema: comparisonInputSchema,
      outputSchema: siteComparisonOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<CallToolResult> => {
      // Lexical validation only: no filesystem probing or database identity inference.
      if (resolve(input.sourcePath) === resolve(input.targetPath))
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'SAME_INSTALLATION: Source and target paths normalize to the same path. Choose distinct WordPress installations.',
            },
          ],
        };
      try {
        const info = siteComparisonOutputSchema.parse(
          await createService().compare(input),
        );
        return {
          structuredContent: info,
          content: [{ type: 'text', text: JSON.stringify(info) }],
        };
      } catch (error) {
        if (error instanceof z.ZodError)
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'INVALID_COMPARISON_RESPONSE: Site comparison returned unexpected data. Check the server version and comparison service compatibility before retrying.',
              },
            ],
          };
        // The engine fails as a whole and does not identify the failing side in
        // its error type. Do not infer a side from potentially sensitive output.
        return wpCliToolError(error, 'Site comparison');
      }
    },
  );
}
