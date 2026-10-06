import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { SiteInfoService } from '../wordpress/site-info-service.js';
import { WpCliClient } from '../wordpress/wp-cli-client.js';
import { wordpressPathInputSchema, wpCliToolError } from './wp-cli-tool.js';

export type SiteInfoServiceFactory = (
  path: string,
) => Pick<SiteInfoService, 'getSiteInfo'>;

export function registerSiteInfoTool(
  server: McpServer,
  createService: SiteInfoServiceFactory = (path) =>
    new SiteInfoService(new WpCliClient({ wordpressPath: path })),
): void {
  server.registerTool(
    'migration_site_info',
    {
      description:
        'Read basic information about a trusted local WordPress installation using WP-CLI.',
      inputSchema: wordpressPathInputSchema,
      outputSchema: z.object({
        wordpressVersion: z.string(),
        isMultisite: z.boolean(),
        siteUrl: z.string(),
        homeUrl: z.string(),
        tablePrefix: z.string(),
        phpVersion: z.string(),
        wpCliVersion: z.string(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }): Promise<CallToolResult> => {
      try {
        const info = await createService(path).getSiteInfo();
        return {
          structuredContent: { ...info },
          content: [{ type: 'text', text: JSON.stringify(info) }],
        };
      } catch (error) {
        return wpCliToolError(error, 'Site information');
      }
    },
  );
}
