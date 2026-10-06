import { isAbsolute } from 'node:path';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  ProcessExecutionError,
  type ProcessErrorCode,
} from '../utils/process-runner.js';
import { SiteInfoService } from '../wordpress/site-info-service.js';
import { WpCliClient, WpCliOutputError } from '../wordpress/wp-cli-client.js';

export type SiteInfoServiceFactory = (
  path: string,
) => Pick<SiteInfoService, 'getSiteInfo'>;

const processErrorMessages: Record<ProcessErrorCode, string> = {
  EXECUTABLE_NOT_FOUND:
    'WP-CLI was not found. Install wp and ensure it is on the MCP server process PATH.',
  TIMEOUT:
    'WP-CLI timed out. Check the installation and database connectivity before retrying.',
  NON_ZERO_EXIT:
    'WP-CLI failed. Verify the WordPress path, file permissions, configuration, and database connectivity.',
  SIGNAL_TERMINATION:
    'WP-CLI was terminated by a signal. Check the host process limits before retrying.',
  OUTPUT_LIMIT:
    'WP-CLI output exceeded the capture limit. Check for excessive startup output from the installation.',
  SPAWN_ERROR:
    'WP-CLI could not start. Check the executable, PHP installation, and execution permissions.',
};

function toolError(error: unknown): CallToolResult {
  let message: string;
  if (error instanceof ProcessExecutionError) {
    message = `${error.code}: ${processErrorMessages[error.code]}`;
    if (error.code === 'NON_ZERO_EXIT' && error.result.exitCode !== null) {
      message += ` Exit code: ${error.result.exitCode}.`;
    }
  } else if (error instanceof WpCliOutputError) {
    message =
      'INVALID_WP_CLI_OUTPUT: WP-CLI returned unexpected data. Check WP-CLI compatibility and installation startup output.';
  } else {
    message =
      'INTERNAL_ERROR: Site information could not be retrieved due to an unexpected server error.';
  }
  return { isError: true, content: [{ type: 'text', text: message }] };
}

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
      inputSchema: z.strictObject({
        path: z
          .string()
          .min(1, 'path is required')
          .refine((path) => path.trim().length > 0, 'path must not be blank')
          .refine(
            (path) => !path.includes('\0'),
            'path must not contain NUL bytes',
          )
          .refine(isAbsolute, 'path must be an absolute filesystem path')
          .describe(
            'Absolute path to the WordPress installation on the MCP server host.',
          ),
      }),
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
        return toolError(error);
      }
    },
  );
}
