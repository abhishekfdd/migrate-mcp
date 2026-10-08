import { describe, expect, it, vi } from 'vitest';
import {
  WpCliClient,
  WpCliOutputError,
} from '../../src/wordpress/wp-cli-client.js';
import { urlReferenceMetadataPhp } from '../../src/wordpress/url-reference-inspection.js';
import {
  ProcessExecutionError,
  type runProcess,
} from '../../src/utils/process-runner.js';
import {
  referenceMetadata,
  emptyReferenceMetadata,
} from '../fixtures/url-reference-metadata.js';

function setup(stdout: string) {
  const runner = vi
    .fn<typeof runProcess>()
    .mockResolvedValue({ stdout, stderr: '', exitCode: 0, signal: null });
  return {
    runner,
    client: new WpCliClient(
      {
        wordpressPath: '/site; --exec=untrusted',
        wpBinaryPath: '/tools/wp',
        timeoutMs: 5000,
      },
      runner,
    ),
  };
}

describe('WP-CLI URL reference metadata', () => {
  it('uses controlled read-only PHP with path outside the code and returns typed summaries', async () => {
    const { runner, client } = setup(JSON.stringify(referenceMetadata));
    await expect(client.getUrlReferenceMetadata()).resolves.toEqual(
      referenceMetadata,
    );
    expect(runner).toHaveBeenCalledExactlyOnceWith(
      '/tools/wp',
      [
        'eval',
        urlReferenceMetadataPhp,
        '--path=/site; --exec=untrusted',
        '--no-color',
        '--skip-packages',
      ],
      { timeoutMs: 5000 },
    );
    expect(urlReferenceMetadataPhp).not.toMatch(
      /untrusted|\b(?:INSERT|UPDATE|DELETE|DROP|ALTER)\b|SELECT \*|\b(?:unserialize|maybe_unserialize)\s*\(/,
    );
    expect(urlReferenceMetadataPhp).toContain('LIMIT 100');
    expect(urlReferenceMetadataPhp).toContain('wp_upload_dir(null, false)');
  });

  it('parses numeric strings and preserves numeric host/location values', async () => {
    const { client } = setup(
      JSON.stringify({
        ...referenceMetadata,
        totalReferences: '6',
        siteId: '3',
        sourceUrlReferences: '3',
        hostCounts: Object.fromEntries(
          Object.entries(referenceMetadata.hostCounts).map(([host, count]) => [
            host,
            String(count),
          ]),
        ),
        locations: referenceMetadata.locations.map(
          ({ source, referenceCount }) => ({
            source,
            referenceCount: String(referenceCount),
          }),
        ),
      }),
    );
    await expect(client.getUrlReferenceMetadata()).resolves.toEqual(
      referenceMetadata,
    );
  });

  it('accepts zero references and unavailable configuration', async () => {
    const { client } = setup(
      JSON.stringify({
        ...emptyReferenceMetadata,
        siteUrl: undefined,
        homeUrl: undefined,
        uploadBaseUrl: undefined,
      }),
    );
    const data = await client.getUrlReferenceMetadata();
    expect(data.totalReferences).toBe(0);
    expect(data.siteUrl).toBeUndefined();
    expect(data.hostCounts).toEqual({});
  });

  it('strips raw rows, secrets, and unexpected location values', async () => {
    const { client } = setup(
      JSON.stringify({
        ...referenceMetadata,
        password: 'private',
        rows: [{ content: 'private' }],
        locations: referenceMetadata.locations.map((entry) => ({
          ...entry,
          rawValue: 'private',
        })),
      }),
    );
    const result = await client.getUrlReferenceMetadata();
    expect(result).toEqual(referenceMetadata);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it.each([
    'not json',
    'null',
    '[]',
    '{}',
    ...[
      { totalReferences: -1 },
      { totalReferences: '6 URLs' },
      { totalReferences: '9007199254740992' },
      { totalReferences: 7 },
      { httpReferences: 3 },
      { sourceUrlReferences: 4 },
      { hostCounts: { 'private-user:private-pass@host': 6 } },
      { hostCounts: { 'BAD.EXAMPLE': 6 } },
      { hostCounts: { 'bad..example': 6 } },
      { hostCounts: { 'valid.example': 'private' } },
      { externalMediaReferences: 7 },
      { externalMediaHostCounts: { 'other.example.org': 2 } },
      { siteUrlReferences: 7 },
      { serializedValueReferences: 7 },
      { jsonValueReferences: true },
      { filesystemPathReferences: 1.5 },
      { skippedOversizedValues: -1 },
      { siteId: 0 },
      { multisite: 'true' },
      { siteUrl: 'https://private:secret@example.com/' },
      { homeUrl: 'https://example.com/?token=private' },
      { uploadBaseUrl: 'https://example.com/#private' },
      { homeUrl: 'file:///private' },
      { locations: referenceMetadata.locations.slice(1) },
      {
        locations: referenceMetadata.locations.map((entry) => ({
          ...entry,
          source: 'wp_posts.post_content',
        })),
      },
      {
        locations: referenceMetadata.locations.map((entry) => ({
          ...entry,
          referenceCount: 0,
        })),
      },
      { alternateSourceHosts: ['example.com', 'example.com'] },
    ].map((bad) => JSON.stringify({ ...referenceMetadata, ...bad })),
  ])('rejects malformed, unsafe, or inconsistent output %s', async (stdout) => {
    await expect(
      setup(stdout).client.getUrlReferenceMetadata(),
    ).rejects.toBeInstanceOf(WpCliOutputError);
  });

  it('preserves process failures rather than returning empty summaries', async () => {
    const { runner, client } = setup('');
    const error = new ProcessExecutionError(
      'TIMEOUT',
      { stdout: '', stderr: '', exitCode: null, signal: 'SIGKILL' },
      new Error('timeout'),
    );
    runner.mockRejectedValueOnce(error);
    await expect(client.getUrlReferenceMetadata()).rejects.toBe(error);
  });
});
