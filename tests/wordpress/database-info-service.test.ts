import { describe, expect, it, vi } from 'vitest';
import { DatabaseInfoService } from '../../src/wordpress/database-info-service.js';
import {
  WpCliClient,
  WpCliOutputError,
} from '../../src/wordpress/wp-cli-client.js';
import {
  ProcessExecutionError,
  type runProcess,
} from '../../src/utils/process-runner.js';
import { databaseMetadataPhp } from '../../src/wordpress/database-metadata.js';

const blogTables = [
  'posts',
  'postmeta',
  'comments',
  'commentmeta',
  'terms',
  'term_taxonomy',
  'term_relationships',
  'termmeta',
  'options',
  'links',
];
const singleSiteCore = [...blogTables, 'users', 'usermeta'].map(
  (name) => `custom_${name}`,
);

function setup(overrides: Record<string, unknown> = {}, multisite = false) {
  const response = {
    databaseName: 'wordpress',
    databaseHost: 'db.internal:3306',
    tables: singleSiteCore,
    coreTables: singleSiteCore,
    sizeBytes: '1048576',
    charset: 'utf8mb4',
    collation: 'utf8mb4_unicode_ci',
    siteCount: null,
    ...overrides,
  };
  const runner = vi
    .fn<typeof runProcess>()
    .mockImplementation(async (_binary, args) => ({
      stdout: JSON.stringify(
        args[1] === databaseMetadataPhp
          ? response
          : {
              isMultisite: multisite,
              siteUrl: 'https://example.test',
              homeUrl: 'https://example.test',
              tablePrefix: multisite ? 'custom_2_' : 'custom_',
            },
      ),
      stderr: '',
      exitCode: 0,
      signal: null,
    }));
  const client = new WpCliClient({ wordpressPath: '/site' }, runner);
  return { runner, service: new DatabaseInfoService(client) };
}

describe('DatabaseInfoService', () => {
  it('summarizes a normal single-site installation with numeric metadata', async () => {
    const { service, runner } = setup();
    await expect(service.getDatabaseInfo()).resolves.toEqual({
      databaseName: 'wordpress',
      databaseHost: 'db.internal:3306',
      tablePrefix: 'custom_',
      tableCount: 12,
      coreTableCount: 12,
      customTableCount: 0,
      sizeBytes: 1048576,
      charset: 'utf8mb4',
      collation: 'utf8mb4_unicode_ci',
      multisite: false,
    });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('counts multisite globals once and includes core tables for each blog', async () => {
    const networkCore = [
      ...singleSiteCore,
      ...blogTables.map((name) => `custom_2_${name}`),
      ...[
        'blogs',
        'blogmeta',
        'site',
        'sitemeta',
        'signups',
        'registration_log',
      ].map((name) => `custom_${name}`),
    ];
    const { service } = setup(
      {
        tables: [...networkCore, 'custom_2_plugin_data'],
        coreTables: networkCore,
        siteCount: '2',
      },
      true,
    );
    await expect(service.getDatabaseInfo()).resolves.toMatchObject({
      tablePrefix: 'custom_2_',
      tableCount: 29,
      coreTableCount: 28,
      customTableCount: 1,
      multisite: true,
      siteCount: 2,
    });
  });

  it('counts custom and unrelated tables without classifying them by prefix alone', async () => {
    const { service } = setup({
      tables: [...singleSiteCore, 'custom_plugin', 'other_posts'],
    });
    await expect(service.getDatabaseInfo()).resolves.toMatchObject({
      tableCount: 14,
      coreTableCount: 12,
      customTableCount: 2,
    });
  });

  it('counts only core tables that actually exist', async () => {
    const { service } = setup({ tables: ['custom_posts', 'custom_plugin'] });
    await expect(service.getDatabaseInfo()).resolves.toMatchObject({
      tableCount: 2,
      coreTableCount: 1,
      customTableCount: 1,
    });
  });

  it.each([null, undefined])(
    'omits unavailable optional metadata (%s)',
    async (missing) => {
      const { service } = setup(
        {
          sizeBytes: missing,
          charset: missing,
          collation: missing,
          siteCount: missing,
        },
        true,
      );
      const result = await service.getDatabaseInfo();
      expect(result).not.toHaveProperty('sizeBytes');
      expect(result).not.toHaveProperty('charset');
      expect(result).not.toHaveProperty('collation');
      expect(result).not.toHaveProperty('siteCount');
    },
  );

  it('preserves a zero size and omits empty charset/collation', async () => {
    const { service } = setup({
      tables: [],
      sizeBytes: '0',
      charset: '',
      collation: '',
      siteCount: 1,
    });
    const result = await service.getDatabaseInfo();
    expect(result).toMatchObject({
      tableCount: 0,
      coreTableCount: 0,
      customTableCount: 0,
      sizeBytes: 0,
    });
    expect(result).not.toHaveProperty('charset');
    expect(result).not.toHaveProperty('collation');
    expect(result).not.toHaveProperty('siteCount');
  });

  it('never returns credentials or raw table lists from unexpected response fields', async () => {
    const { service } = setup({
      DB_USER: 'private-user',
      DB_PASSWORD: 'private-password',
      databaseUsername: 'private-user',
    });
    const result = await service.getDatabaseInfo();
    expect(JSON.stringify(result)).not.toMatch(
      /private|DB_USER|DB_PASSWORD|databaseUsername/,
    );
    expect(result).not.toHaveProperty('tables');
    expect(result).not.toHaveProperty('coreTables');
  });

  it('rejects malformed metadata rather than reporting misleading counts', async () => {
    const { service } = setup({ tables: 'not-an-array' });
    await expect(service.getDatabaseInfo()).rejects.toBeInstanceOf(
      WpCliOutputError,
    );
  });

  it('propagates failures to read required database metadata', async () => {
    const { service, runner } = setup();
    const error = new ProcessExecutionError(
      'NON_ZERO_EXIT',
      { stdout: '', stderr: 'failed', exitCode: 1, signal: null },
      new Error('failed'),
    );
    runner.mockRejectedValueOnce(error);
    await expect(service.getDatabaseInfo()).rejects.toBe(error);
  });
});
