import { z } from 'zod';
import {
  contentTypeMetadataPhp,
  contentTypeMetadataSchema,
  type WpContentTypeMetadata,
} from './content-type-metadata.js';
import {
  databaseMetadataPhp,
  databaseMetadataSchema,
  type WpDatabaseMetadata,
} from './database-metadata.js';
import {
  taxonomyMetadataPhp,
  taxonomyMetadataSchema,
  type WpTaxonomyMetadata,
} from './taxonomy-metadata.js';
import {
  tableMetadataPhp,
  tableMetadataSchema,
  type WpTableMetadata,
} from './table-metadata.js';
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

const siteUrlSchema = z
  .string()
  .url()
  .regex(/^https?:\/\//);
const siteMetadataSchema = z.object({
  isMultisite: z.boolean(),
  siteUrl: siteUrlSchema,
  homeUrl: siteUrlSchema,
  // WordPress permits an empty prefix as well as letters, numbers, and underscores.
  tablePrefix: z.string().regex(/^[A-Za-z0-9_]*$/),
});

export type WpSiteMetadata = z.infer<typeof siteMetadataSchema>;

// Fixed read-only PHP: never interpolate paths, options, or caller-supplied code.
const siteMetadataPhp = `global $wpdb;
echo wp_json_encode(array(
    'isMultisite' => (bool) is_multisite(),
    'siteUrl' => get_option('siteurl'),
    'homeUrl' => get_option('home'),
    'tablePrefix' => $wpdb->prefix
));`;

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

  async getSiteMetadata(): Promise<WpSiteMetadata> {
    const { stdout } = await this.#execute(['eval', siteMetadataPhp]);
    try {
      return siteMetadataSchema.parse(JSON.parse(stdout));
    } catch (error) {
      throw new WpCliOutputError('eval (site metadata)', error);
    }
  }

  async getDatabaseMetadata(): Promise<WpDatabaseMetadata> {
    const { stdout } = await this.#execute(['eval', databaseMetadataPhp]);
    try {
      return databaseMetadataSchema.parse(JSON.parse(stdout));
    } catch (error) {
      throw new WpCliOutputError('eval (database metadata)', error);
    }
  }

  async getContentTypeMetadata(): Promise<WpContentTypeMetadata[]> {
    // Plugins and themes must load to register their custom post types.
    const { stdout } = await this.#execute(
      ['eval', contentTypeMetadataPhp],
      true,
    );
    try {
      return contentTypeMetadataSchema.parse(JSON.parse(stdout));
    } catch (error) {
      throw new WpCliOutputError('eval (content type metadata)', error);
    }
  }

  async getTaxonomyMetadata(): Promise<WpTaxonomyMetadata[]> {
    // Plugins and themes must load to register their custom taxonomies.
    const { stdout } = await this.#execute(['eval', taxonomyMetadataPhp], true);
    try {
      return taxonomyMetadataSchema.parse(JSON.parse(stdout));
    } catch (error) {
      throw new WpCliOutputError('eval (taxonomy metadata)', error);
    }
  }

  async getTableMetadata(): Promise<WpTableMetadata> {
    const { stdout } = await this.#execute(['eval', tableMetadataPhp]);
    try {
      return tableMetadataSchema.parse(JSON.parse(stdout));
    } catch (error) {
      throw new WpCliOutputError('eval (table metadata)', error);
    }
  }

  #execute(
    args: readonly string[],
    loadWordPressExtensions = false,
  ): Promise<ProcessResult> {
    return this.#runner(
      this.#wpBinaryPath,
      [
        ...args,
        `--path=${this.#wordpressPath}`,
        '--no-color',
        ...(loadWordPressExtensions ? [] : ['--skip-plugins', '--skip-themes']),
        '--skip-packages',
      ],
      this.#processOptions,
    );
  }
}
