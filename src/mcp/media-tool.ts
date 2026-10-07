import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  MediaAnalyzer,
  type MediaAnalysis,
} from '../migration/media-analyzer.js';
import { WpCliClient } from '../wordpress/wp-cli-client.js';
import { wordpressPathInputSchema, wpCliToolError } from './wp-cli-tool.js';

export type MediaAnalyzerFactory = (
  path: string,
) => Pick<MediaAnalyzer, 'analyze'>;

const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const mediaAnalysisOutputSchema = z.object({
  totalAttachments: countSchema,
  minAttachmentId: countSchema.optional(),
  maxAttachmentId: countSchema.optional(),
  mimeTypeCounts: z.record(z.string(), countSchema),
  categoryCounts: z.record(z.string(), countSchema),
  missingAttachedFileMeta: countSchema,
  missingAttachmentMetadata: countSchema,
  missingLocalFiles: countSchema.optional(),
  checkedLocalFiles: countSchema.optional(),
  unattachedAttachments: countSchema,
  orphanedAttachments: countSchema,
  uploadBaseDir: z.string().optional(),
  uploadBaseUrl: z.string().optional(),
  usesYearMonthFolders: z.boolean().optional(),
  externalMediaCount: countSchema,
  multisite: z.boolean(),
  siteId: countSchema.positive(),
  warnings: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      count: countSchema.optional(),
    }),
  ),
} satisfies Record<keyof MediaAnalysis, z.ZodType>);

export function registerMediaTool(
  server: McpServer,
  createAnalyzer: MediaAnalyzerFactory = (path) =>
    new MediaAnalyzer(new WpCliClient({ wordpressPath: path })),
): void {
  server.registerTool(
    'migration_analyze_media',
    {
      description:
        'Read media migration summaries for the active site in a trusted local WordPress installation: attachment counts, MIME distribution, missing metadata, parent anomalies, upload configuration, and external-reference indicators. Physical file checks are not enabled; missingLocalFiles and checkedLocalFiles are omitted with a warning.',
      inputSchema: wordpressPathInputSchema,
      outputSchema: mediaAnalysisOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }): Promise<CallToolResult> => {
      try {
        // Preserve the analyzer's default summary mode and allow only domain fields.
        const info = mediaAnalysisOutputSchema.parse(
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
                text: 'INVALID_ANALYZER_RESPONSE: Media analysis returned unexpected data. Check the server version and analyzer compatibility before retrying.',
              },
            ],
          };
        }
        if (
          error instanceof Error &&
          'code' in error &&
          typeof error.code === 'string' &&
          ['EACCES', 'EPERM', 'ENOENT'].includes(error.code)
        ) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'FILESYSTEM_ACCESS_ERROR: Media analysis could not access required files. Verify the WordPress path and upload directory availability and permissions before retrying.',
              },
            ],
          };
        }
        return wpCliToolError(error, 'Media analysis');
      }
    },
  );
}
