import { z } from 'zod';
import {
  runProcess,
  type ProcessOptions,
  type ProcessResult,
} from '../utils/process-runner.js';

export interface WpCliClientOptions {
  wordpressPath: string;
  /** Trusted executable name or path; defaults to wp. */
  wpBinaryPath?: string;
  timeoutMs?: number;
}

export interface CoreVersion {
  version: string;
}

const optionalPath = z
  .union([z.string(), z.literal(false), z.null()])
  .optional();
const cliInfoSchema = z.object({
  wp_cli_version: z.string().min(1),
  system_os: z.string(),
  php_binary_path: z.string(),
  php_version: z.string().min(1),
  shell: optionalPath,
  php_ini_used: optionalPath,
  php_memory_limit: z.string().optional(),
  wp_cli_dir_path: z.string().optional(),
  wp_cli_vendor_path: z.string().optional(),
  wp_cli_phar_path: z.string().optional(),
  wp_cli_packages_dir_path: optionalPath,
  wp_cli_cache_dir_path: z.string().optional(),
  global_config_path: optionalPath,
  project_config_path: optionalPath,
  mysql_binary_path: optionalPath,
  mysql_version: optionalPath,
  sql_modes: z.array(z.string()).optional(),
});

export type WpCliInfo = z.infer<typeof cliInfoSchema>;

export class WpCliOutputError extends Error {
  constructor(command: string, cause?: unknown) {
    super(`Invalid output from wp ${command}`, { cause });
    this.name = 'WpCliOutputError';
  }
}

/** Read-only metadata commands for a trusted local WordPress installation. */
export class WpCliClient {
  readonly #wordpressPath: string;
  readonly #wpBinaryPath: string;
  readonly #processOptions: ProcessOptions;
  readonly #runner: typeof runProcess;

  constructor(
    options: WpCliClientOptions,
    runner: typeof runProcess = runProcess,
  ) {
    const wpBinaryPath = options.wpBinaryPath ?? 'wp';
    for (const [name, value] of [
      ['wordpressPath', options.wordpressPath],
      ['wpBinaryPath', wpBinaryPath],
    ] as const) {
      if (!value.trim() || value.includes('\0')) {
        throw new TypeError(
          `${name} must be non-empty and contain no NUL bytes`,
        );
      }
    }
    this.#wordpressPath = options.wordpressPath;
    this.#wpBinaryPath = wpBinaryPath;
    this.#processOptions =
      options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
    this.#runner = runner;
  }

  async getCoreVersion(): Promise<CoreVersion> {
    const { stdout } = await this.#execute(['core', 'version']);
    const version = stdout.trim();
    // Accept stable and development versions, but reject empty or noisy output.
    if (!/^\d+\.\d+(?:\.\d+)*(?:-[A-Za-z0-9.-]+)?$/.test(version)) {
      throw new WpCliOutputError('core version');
    }
    return { version };
  }

  async getCliInfo(): Promise<WpCliInfo> {
    const { stdout } = await this.#execute(['cli', 'info', '--format=json']);
    try {
      return cliInfoSchema.parse(JSON.parse(stdout));
    } catch (error) {
      throw new WpCliOutputError('cli info', error);
    }
  }

  #execute(args: readonly string[]): Promise<ProcessResult> {
    return this.#runner(
      this.#wpBinaryPath,
      [
        ...args,
        `--path=${this.#wordpressPath}`,
        '--no-color',
        '--skip-plugins',
        '--skip-themes',
        '--skip-packages',
      ],
      this.#processOptions,
    );
  }
}
