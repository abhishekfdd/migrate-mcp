import { isAbsolute } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  ProcessExecutionError,
  type ProcessErrorCode,
} from '../utils/process-runner.js';
import { WpCliOutputError } from '../wordpress/wp-cli-client.js';

export const wordpressPathInputSchema = z.strictObject({
  path: z
    .string()
    .min(1, 'path is required')
    .refine((path) => path.trim().length > 0, 'path must not be blank')
    .refine((path) => !path.includes('\0'), 'path must not contain NUL bytes')
    .refine(isAbsolute, 'path must be an absolute filesystem path')
    .describe(
      'Absolute path to the WordPress installation on the MCP server host.',
    ),
});

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

export function wpCliToolError(
  error: unknown,
  subject: string,
): CallToolResult {
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
    message = `INTERNAL_ERROR: ${subject} could not be retrieved due to an unexpected server error.`;
  }
  return { isError: true, content: [{ type: 'text', text: message }] };
}
