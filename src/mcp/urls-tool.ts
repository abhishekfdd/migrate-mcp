import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { UrlReferenceAnalyzer } from '../migration/url-reference-analyzer.js';
import { urlReferenceMetadataSchema } from '../wordpress/url-reference-metadata.js';
import { WpCliClient } from '../wordpress/wp-cli-client.js';
import { wordpressPathInputSchema, wpCliToolError } from './wp-cli-tool.js';

export type UrlReferenceAnalyzerFactory = (
  path: string,
) => Pick<UrlReferenceAnalyzer, 'analyze'>;

// Reuse the existing summary validation and privacy constraints, including nested
// field projection. The analyzer adds only structured warnings to this shape.
const urlAnalysisOutputSchema = urlReferenceMetadataSchema.safeExtend({
  warnings: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      count: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .optional(),
    }),
  ),
});

export function registerUrlsTool(
  server: McpServer,
  createAnalyzer: UrlReferenceAnalyzerFactory = (path) =>
    new UrlReferenceAnalyzer(new WpCliClient({ wordpressPath: path })),
): void {
  server.registerTool(
    'migration_analyze_urls',
    {
      description:
        'Read URL/reference migration summaries for the active site in a trusted local WordPress installation: source-domain dependencies, external hosts, protocols, serialized/JSON references, filesystem and development indicators, database locations, and scan-limit warnings. Returns summaries only; does not return raw matched content or replace values.',
      inputSchema: wordpressPathInputSchema,
      outputSchema: urlAnalysisOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }): Promise<CallToolResult> => {
      try {
        const info = urlAnalysisOutputSchema.parse(
          await createAnalyzer(path).analyze(),
        );
        return {
          structuredContent: info,
          content: [{ type: 'text', text: JSON.stringify(info) }],
        };
      } catch (error) {
        if (error instanceof z.ZodError) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'INVALID_ANALYZER_RESPONSE: URL/reference analysis returned unexpected data. Check the server version and analyzer compatibility before retrying.',
              },
            ],
          };
        }
        return wpCliToolError(error, 'URL/reference analysis');
      }
    },
  );
}
