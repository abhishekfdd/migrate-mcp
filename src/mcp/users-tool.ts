import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { UserAnalyzer, type UserAnalysis } from '../migration/user-analyzer.js';
import { WpCliClient } from '../wordpress/wp-cli-client.js';
import { wordpressPathInputSchema, wpCliToolError } from './wp-cli-tool.js';

export type UserAnalyzerFactory = (
  path: string,
) => Pick<UserAnalyzer, 'analyze'>;

const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const userAnalysisOutputSchema = z.object({
  totalUsers: countSchema,
  minUserId: countSchema.optional(),
  maxUserId: countSchema.optional(),
  multisite: z.boolean(),
  roleSiteId: countSchema.positive(),
  siteUserCount: countSchema,
  administratorCount: countSchema,
  roleCounts: z.record(z.string().min(1), countSchema),
  usersWithoutRole: countSchema,
  duplicateEmailCount: countSchema,
  duplicateLoginCount: countSchema,
  siteMemberships: z
    .array(
      z.object({
        siteId: countSchema.positive(),
        userCount: countSchema,
      }),
    )
    .optional(),
  usersWithLargeMetaSets: countSchema.optional(),
  warnings: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      count: countSchema.optional(),
    }),
  ),
} satisfies Record<keyof UserAnalysis, z.ZodType>);

export function registerUsersTool(
  server: McpServer,
  createAnalyzer: UserAnalyzerFactory = (path) =>
    new UserAnalyzer(new WpCliClient({ wordpressPath: path })),
): void {
  server.registerTool(
    'migration_analyze_users',
    {
      description:
        'Read user migration statistics for a trusted local WordPress installation: shared user totals, active-site roles, multisite memberships, duplicate indicators, and usermeta risk summaries. Does not return user records or auth secrets.',
      inputSchema: wordpressPathInputSchema,
      outputSchema: userAnalysisOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }): Promise<CallToolResult> => {
      try {
        // Allow only the domain's summary fields, including nested objects.
        const info = userAnalysisOutputSchema.parse(
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
                text: 'INVALID_ANALYZER_RESPONSE: User analysis returned unexpected data. Check the server version and analyzer compatibility before retrying.',
              },
            ],
          };
        }
        return wpCliToolError(error, 'User analysis');
      }
    },
  );
}
