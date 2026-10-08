import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { urlReferenceMetadataPhp } from '../../src/wordpress/url-reference-inspection.js';
import { urlReferenceMetadataSchema } from '../../src/wordpress/url-reference-metadata.js';
import { runProcess } from '../../src/utils/process-runner.js';
import { urlReferenceRuntimePhp } from '../fixtures/url-reference-runtime.js';

// Optional PHP-only verification. All WordPress and database APIs are mocked.
const hasPhp = spawnSync('php', ['-v'], { timeout: 5000 }).status === 0;
type Values = Record<
  string,
  { id: number; text: string | null; key?: string }[]
>;
async function inspect(
  values: Values,
  overrides: Record<string, unknown> = {},
) {
  const fixture = {
    options: {
      siteurl: 'https://www.example.com/wp',
      home: 'https://example.com/blog',
    },
    uploads: { baseurl: 'https://cdn.example.com/uploads', error: false },
    values,
    ...overrides,
  };
  const result = await runProcess('php', [
    '-r',
    urlReferenceRuntimePhp +
      urlReferenceMetadataPhp +
      '\nfwrite(STDERR, json_encode(array("queries" => $wpdb->queries, "suppressed" => $wpdb->suppressed)));',
    Buffer.from(JSON.stringify(fixture)).toString('base64'),
  ]);
  const trace = JSON.parse(result.stderr) as {
    queries: string[];
    suppressed: boolean;
  };
  expect(trace.suppressed).toBe(false);
  return {
    data: urlReferenceMetadataSchema.parse(JSON.parse(result.stdout)),
    trace,
    raw: result.stdout,
  };
}

describe.skipIf(!hasPhp)(
  'URL reference inspection with mocked WordPress/database runtime',
  () => {
    it('counts source/home bases, protocols, external hosts, and upload URLs in post content', async () => {
      const { data } = await inspect({
        'wp_posts.post_content': [
          {
            id: 1,
            text: 'http://WWW.Example.com/wp/one https://www.example.com/wp/two https://example.com/blog/home https://unrelated.net/var/www/notfile //cdn.example.com/uploads/a.jpg',
          },
        ],
      });
      expect(data).toMatchObject({
        totalReferences: 5,
        sourceUrlReferences: 3,
        externalUrlReferences: 2,
        siteUrlReferences: 2,
        homeUrlReferences: 1,
        uploadUrlReferences: 1,
        httpReferences: 1,
        httpsReferences: 3,
        protocolRelativeReferences: 1,
        hostCounts: {
          'www.example.com': 2,
          'example.com': 1,
          'unrelated.net': 1,
          'cdn.example.com': 1,
        },
        externalMediaHostCounts: { 'cdn.example.com': 1 },
        filesystemPathReferences: 0,
      });
      expect(
        data.locations.find(({ source }) => source === 'wp_posts.post_content')
          ?.referenceCount,
      ).toBe(5);
    });

    it('detects serialized-looking postmeta without instantiating objects', async () => {
      const url = 'https://www.example.com/wp/image';
      const { data } = await inspect({
        'wp_postmeta.meta_value': [
          { id: 1, text: `s:${url.length}:"${url}";`, key: 'image_url' },
          {
            id: 2,
            text: `O:8:"UrlProbe":1:{s:3:"url";s:${url.length}:"${url}";}`,
            key: 'layout',
          },
        ],
      });
      expect(data.serializedValueReferences).toBe(2);
      expect(
        data.locations.find(({ source }) => source === 'wp_postmeta.meta_value')
          ?.referenceCount,
      ).toBe(2);
      expect(urlReferenceMetadataPhp).not.toMatch(
        /\b(?:unserialize|maybe_unserialize)\s*\(/,
      );
    });

    it('decodes JSON URLs and excludes sensitive nested fields in options', async () => {
      const { data, raw } = await inspect({
        'wp_options.option_value': [
          {
            id: 1,
            key: 'layout',
            text: String.raw`{"url":"https:\/\/other.example\/one","nested":[{"url":"https:\u002f\u002fsecond.example\u002ftwo"}],"api_key":"https://private.example/secret"}`,
          },
        ],
      });
      expect(data).toMatchObject({
        totalReferences: 2,
        jsonValueReferences: 2,
        skippedSensitiveValues: 1,
        hostCounts: { 'other.example': 1, 'second.example': 1 },
      });
      expect(raw).not.toMatch(/private|secret|api_key|nested/);
      expect(
        data.locations.find(
          ({ source }) => source === 'wp_options.option_value',
        )?.referenceCount,
      ).toBe(2);
    });

    it('falls back to text for malformed JSON and safely ignores malformed URL-like tokens', async () => {
      const { data } = await inspect({
        'wp_options.option_value': [
          {
            id: 1,
            key: 'layout',
            text: '{"url":"https:\\/\\/good.example/a", broken https://bad..example/a https://999.1.1.1/a https://example.com:99999/a',
          },
        ],
      });
      expect(data).toMatchObject({
        totalReferences: 1,
        jsonValueReferences: 0,
        malformedUrlReferences: 3,
        hostCounts: { 'good.example': 1 },
      });
    });

    it.each([
      'localhost',
      '127.0.0.1',
      '[::1]',
      'demo.local',
      'demo.test',
      'demo.localhost',
      'staging.example.com',
      'dev-one.example.com',
    ])('detects development hostname %s conservatively', async (host) => {
      const { data } = await inspect({
        'wp_posts.post_excerpt': [{ id: 1, text: `http://${host}/x` }],
      });
      expect(data.developmentReferenceCount).toBe(1);
    });

    it('does not confuse ordinary external hosts with development or media hosts', async () => {
      const { data } = await inspect({
        'wp_comments.comment_content': [
          {
            id: 1,
            text: 'https://stagecoach.example.com/x https://127.example.com/x https://reference.example.org/article',
          },
        ],
      });
      expect(data).toMatchObject({
        externalUrlReferences: 3,
        developmentReferenceCount: 0,
        externalMediaReferences: 0,
      });
    });

    it('finds observed www variants without claiming all subdomains belong to this site', async () => {
      const { data } = await inspect(
        {
          'wp_posts.post_content': [
            {
              id: 1,
              text: 'https://example.com/one https://unrelated.example.com/two',
            },
          ],
        },
        {
          options: {
            siteurl: 'https://www.example.com/wp',
            home: 'https://www.example.com/',
          },
        },
      );
      expect(data.alternateSourceHosts).toEqual(['example.com']);
      expect(data.sourceUrlReferences).toBe(0);
      expect(data.externalUrlReferences).toBe(2);
    });

    it('normalizes case and trailing dots, ignores ports in host maps, and respects URL base path boundaries', async () => {
      const { data } = await inspect({
        'wp_posts.post_content': [
          {
            id: 1,
            text: 'https://WWW.EXAMPLE.COM.:443/wp/yes http://www.example.com:80/wp/yes https://www.example.com/wp-other/no https://www.example.com:8443/wp/no',
          },
        ],
      });
      expect(data.hostCounts).toEqual({ 'www.example.com': 4 });
      expect(data.siteUrlReferences).toBe(2);
    });

    it('counts CDN and media-extension indicators without fetching remote URLs', async () => {
      const { data } = await inspect({
        'wp_termmeta.meta_value': [
          {
            id: 1,
            key: 'layout',
            text: 'https://a.cloudfront.net/resource https://cdn.provider.org/resource https://photos.example.org/a.webp https://normal.example.org/article',
          },
        ],
      });
      expect(data.externalMediaReferences).toBe(3);
      expect(data.externalMediaHostCounts).toEqual({
        'a.cloudfront.net': 1,
        'cdn.provider.org': 1,
        'photos.example.org': 1,
      });
    });

    it('counts filesystem hints without returning paths or counting URL paths', async () => {
      const { data, raw } = await inspect({
        'wp_commentmeta.meta_value': [
          {
            id: 1,
            key: 'layout',
            text: JSON.stringify({
              linux: '/var/www/private/uploads',
              windows: 'C:\\private\\uploads',
              url: 'https://example.org/var/www/inside-url',
            }),
          },
        ],
      });
      expect(data.filesystemPathReferences).toBe(2);
      expect(raw).not.toContain('private');
    });

    it('removes credentials/query/fragment data from returned configuration and only summarizes discovered hosts', async () => {
      const { data, raw } = await inspect(
        {
          'wp_posts.post_content': [
            {
              id: 1,
              text: 'https://private-user:private-pass@example.org/private-path?token=private-token#private-fragment',
            },
          ],
        },
        {
          options: {
            siteurl:
              'https://private-user:private-pass@www.example.com/wp?key=private#private',
            home: 'https://example.com/',
          },
          uploads: {
            baseurl: 'https://cdn.example.com/uploads?secret=private',
          },
        },
      );
      expect(data.siteUrl).toBe('https://www.example.com/wp');
      expect(data.uploadBaseUrl).toBe('https://cdn.example.com/uploads');
      expect(data.hostCounts).toEqual({ 'example.org': 1 });
      expect(raw).not.toContain('private');
    });

    it('excludes known sensitive keys/transients and skips oversized/binary values', async () => {
      const { data, raw } = await inspect({
        'wp_options.option_value': [
          ...[
            'db_password',
            'api_key',
            'session_tokens',
            'auth_salt',
            '_transient_cache',
            '_site_transient_cache',
          ].map((key, i) => ({
            id: i + 1,
            key,
            text: 'https://private.example/secret',
          })),
          { id: 20, key: 'large_layout', text: 'x'.repeat(65537) },
          {
            id: 21,
            key: 'binary_layout',
            text: '\0https://private.example/binary',
          },
        ],
      });
      expect(data).toMatchObject({
        totalReferences: 0,
        skippedSensitiveValues: 6,
        skippedOversizedValues: 1,
        skippedBinaryValues: 1,
      });
      expect(raw).not.toContain('private');
    });

    it('uses keyset pages, visits all selected core columns, and retains active-site scope', async () => {
      const { data, trace } = await inspect(
        {
          'custom_3_posts.post_content': Array.from(
            { length: 205 },
            (_, i) => ({ id: i + 1, text: 'https://external.example/a' }),
          ),
        },
        { prefix: 'custom_3_', multisite: true, siteId: 3 },
      );
      expect(data).toMatchObject({
        totalReferences: 205,
        multisite: true,
        siteId: 3,
        scannedValues: 205,
      });
      expect(data.locations).toHaveLength(7);
      const pages = trace.queries.filter((sql) =>
        sql.includes('OCTET_LENGTH(`post_content`)'),
      );
      expect(pages).toHaveLength(3);
      expect(pages[0]).toContain('> -1 AND `ID` <= 205');
      expect(pages[1]).toContain('> 100 AND `ID` <= 205');
      expect(pages[2]).toContain('> 200 AND `ID` <= 205');
      expect(trace.queries.join('\n')).not.toMatch(
        /\b(?:OFFSET|INSERT|UPDATE|DELETE|ALTER|DROP)\b|usermeta|user_pass|SELECT \*/,
      );
    });

    it('bounds host maps while retaining total and protocol counts', async () => {
      const { data } = await inspect({
        'wp_posts.post_content': [
          {
            id: 1,
            text: Array.from(
              { length: 1005 },
              (_, i) => `https://host${i}.example/a.jpg`,
            ).join(' '),
          },
        ],
      });
      expect(data.totalReferences).toBe(1005);
      expect(data.externalMediaReferences).toBe(1005);
      expect(Object.keys(data.hostCounts)).toHaveLength(1000);
      expect(Object.keys(data.externalMediaHostCounts)).toHaveLength(1000);
      expect(data.unreportedHostReferences).toBe(5);
    });

    it('handles nullable core meta values as empty text', async () => {
      const { data } = await inspect({
        'wp_postmeta.meta_value': [{ id: 1, key: 'layout', text: null }],
      });
      expect(data).toMatchObject({
        totalReferences: 0,
        scannedValues: 1,
        hostCounts: {},
      });
      expect(urlReferenceMetadataPhp).toContain(
        "ELSE COALESCE($column, '') END AS text_value",
      );
    });

    it('rejects bracketed DNS hosts and unsupported Unicode hostnames', async () => {
      const { data } = await inspect({
        'wp_posts.post_content': [
          { id: 1, text: 'https://[example.com]/x https://münich.example/x' },
        ],
      });
      expect(data).toMatchObject({
        totalReferences: 0,
        malformedUrlReferences: 2,
      });
    });

    it('handles zero references and unavailable configuration', async () => {
      const { data } = await inspect(
        {
          'wp_posts.post_content': [
            {
              id: 1,
              text: 'No URLs here. ftp://example.org is outside this scan.',
            },
          ],
        },
        { options: {}, uploads: { error: 'private upload error' } },
      );
      expect(data).toMatchObject({
        totalReferences: 0,
        hostCounts: {},
        externalMediaHostCounts: {},
        scannedValues: 1,
      });
      expect(data.siteUrl).toBeUndefined();
      expect(data.uploadBaseUrl).toBeUndefined();
      expect(
        data.locations.every(({ referenceCount }) => referenceCount === 0),
      ).toBe(true);
    });

    it('fails required database reads without emitting private error details or false empty summaries', async () => {
      await expect(inspect({}, { queryFailure: true })).rejects.toMatchObject({
        code: 'NON_ZERO_EXIT',
        result: {
          stdout: '',
          stderr:
            'Unable to read URL reference data. Check database access and compatibility.',
        },
      });
    });
  },
);
