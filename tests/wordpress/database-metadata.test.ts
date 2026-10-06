import { describe, expect, it, vi } from 'vitest';
import {
  WpCliClient,
  WpCliOutputError,
} from '../../src/wordpress/wp-cli-client.js';
import { databaseMetadataPhp } from '../../src/wordpress/database-metadata.js';
import type { runProcess } from '../../src/utils/process-runner.js';

const metadata = {
  databaseName: 'wordpress',
  databaseHost: 'localhost',
  tables: ['wp_posts'],
  coreTables: ['wp_posts'],
};

function setup(stdout: string) {
  const runner = vi
    .fn<typeof runProcess>()
    .mockResolvedValue({ stdout, stderr: '', exitCode: 0, signal: null });
  const client = new WpCliClient(
    {
      wordpressPath: '/site; --exec=untrusted',
      wpBinaryPath: '/tools/wp',
      timeoutMs: 5000,
    },
    runner,
  );
  return { runner, client };
}

describe('WP-CLI database metadata', () => {
  it('uses only a fixed PHP read through the existing process boundary', async () => {
    const { runner, client } = setup(JSON.stringify(metadata));
    await client.getDatabaseMetadata();
    expect(runner).toHaveBeenCalledExactlyOnceWith(
      '/tools/wp',
      [
        'eval',
        databaseMetadataPhp,
        '--path=/site; --exec=untrusted',
        '--no-color',
        '--skip-plugins',
        '--skip-themes',
        '--skip-packages',
      ],
      { timeoutMs: 5000 },
    );
    expect(databaseMetadataPhp).not.toMatch(
      /DB_USER|DB_PASSWORD|untrusted|\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/,
    );
    expect(databaseMetadataPhp).toContain("'number' => 0");
    expect(databaseMetadataPhp).toContain(
      "$wpdb->tables('all', true, $blog_id)",
    );
  });

  it.each([
    'not json',
    'null',
    '[]',
    '{}',
    ...[
      { databaseName: '' },
      { databaseHost: 42 },
      { tables: [null] },
      { tables: ['wp_posts', 'wp_posts'] },
      { coreTables: {} },
      { sizeBytes: '1 MB' },
      { sizeBytes: -1 },
      { sizeBytes: 1.5 },
      { sizeBytes: '9007199254740992' },
      { siteCount: 'two' },
      { charset: false },
      { collation: [] },
    ].map((invalid) => JSON.stringify({ ...metadata, ...invalid })),
  ])('rejects malformed or unsafe metadata %s', async (stdout) => {
    const { client } = setup(stdout);
    await expect(client.getDatabaseMetadata()).rejects.toBeInstanceOf(
      WpCliOutputError,
    );
  });
});
