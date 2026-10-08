import { describe, expect, it, vi } from 'vitest';
import { UrlReferenceAnalyzer } from '../../src/migration/url-reference-analyzer.js';
import {
  WpCliOutputError,
  type WpCliClient,
} from '../../src/wordpress/wp-cli-client.js';
import {
  referenceMetadata,
  emptyReferenceMetadata,
} from '../fixtures/url-reference-metadata.js';

function setup(data = referenceMetadata) {
  const client = {
    getUrlReferenceMetadata: vi
      .fn<WpCliClient['getUrlReferenceMetadata']>()
      .mockResolvedValue(structuredClone(data)),
  };
  return { client, analyzer: new UrlReferenceAnalyzer(client) };
}

describe('UrlReferenceAnalyzer', () => {
  it('returns aggregate counts with deterministic host and location summaries', async () => {
    const { client, analyzer } = setup();
    const data = await analyzer.analyze();
    expect(data).toMatchObject({
      totalReferences: 6,
      sourceUrlReferences: 3,
      externalUrlReferences: 3,
      siteUrlReferences: 2,
      homeUrlReferences: 1,
      uploadUrlReferences: 1,
      serializedValueReferences: 2,
      jsonValueReferences: 1,
      filesystemPathReferences: 2,
      multisite: true,
      siteId: 3,
    });
    expect(Object.keys(data.hostCounts)).toEqual([
      'cdn.example.com',
      'example.com',
      'localhost',
      'other.example.org',
      'www.example.com',
    ]);
    expect(data.locations.map(({ source }) => source)).toEqual([
      'wp_3_commentmeta.meta_value',
      'wp_3_comments.comment_content',
      'wp_3_options.option_value',
      'wp_3_postmeta.meta_value',
      'wp_3_posts.post_content',
      'wp_3_posts.post_excerpt',
      'wp_3_termmeta.meta_value',
    ]);
    expect(data.warnings.map(({ code, count }) => ({ code, count }))).toEqual([
      { code: 'DEVELOPMENT_URL_REFERENCES', count: 1 },
      { code: 'EXTERNAL_MEDIA_HOSTS', count: 1 },
      { code: 'FILESYSTEM_PATH_REFERENCES', count: 2 },
      { code: 'HTTP_REFERENCES_FOUND', count: 2 },
      { code: 'SERIALIZED_URL_REFERENCES', count: 2 },
      { code: 'SOURCE_DOMAIN_REFERENCES_FOUND', count: 3 },
    ]);
    expect(client.getUrlReferenceMetadata).toHaveBeenCalledExactlyOnceWith();
  });

  it('handles zero references without generating anomaly warnings', async () => {
    const { analyzer } = setup(emptyReferenceMetadata);
    expect(await analyzer.analyze()).toMatchObject({
      totalReferences: 0,
      hostCounts: {},
      externalMediaHostCounts: {},
      warnings: [],
    });
  });

  it('does not classify ordinary external URLs as a migration warning', async () => {
    const { analyzer } = setup({
      ...emptyReferenceMetadata,
      totalReferences: 1,
      externalUrlReferences: 1,
      httpsReferences: 1,
      hostCounts: { 'reference.example.org': 1 },
      locations: emptyReferenceMetadata.locations.map((entry, index) => ({
        ...entry,
        referenceCount: index === 0 ? 1 : 0,
      })),
    });
    expect((await analyzer.analyze()).warnings).toEqual([]);
  });

  it('reports scan limits and omissions without leaking values', async () => {
    const { analyzer } = setup({
      ...emptyReferenceMetadata,
      skippedOversizedValues: 2,
      skippedBinaryValues: 1,
      skippedSensitiveValues: 4,
      malformedUrlReferences: 3,
      unreportedHostReferences: 5,
      totalReferences: 5,
      httpsReferences: 5,
      externalUrlReferences: 5,
      locations: emptyReferenceMetadata.locations.map((entry, index) => ({
        ...entry,
        referenceCount: index === 0 ? 5 : 0,
      })),
    });
    expect(
      (await analyzer.analyze()).warnings.map(({ code, count }) => ({
        code,
        count,
      })),
    ).toEqual([
      { code: 'BINARY_VALUES_SKIPPED', count: 1 },
      { code: 'HOST_SUMMARY_LIMIT', count: 5 },
      { code: 'MALFORMED_URL_REFERENCES', count: 3 },
      { code: 'OVERSIZED_VALUES_SKIPPED', count: 2 },
      { code: 'SENSITIVE_VALUES_EXCLUDED', count: 4 },
    ]);
  });

  it('omits unavailable URL configuration and warns about incomplete classification', async () => {
    const { analyzer } = setup({
      ...emptyReferenceMetadata,
      siteUrl: undefined,
      homeUrl: undefined,
      uploadBaseUrl: undefined,
    });
    const data = await analyzer.analyze();
    for (const key of ['siteUrl', 'homeUrl', 'uploadBaseUrl'])
      expect(data).not.toHaveProperty(key);
    expect(data.warnings).toEqual([
      {
        code: 'REFERENCE_CONFIGURATION_UNAVAILABLE',
        message: expect.any(String),
      },
    ]);
  });

  it('keeps output deterministic without mutating the adapter result', async () => {
    const original = structuredClone(referenceMetadata);
    const { analyzer, client } = setup(original);
    const first = await analyzer.analyze();
    client.getUrlReferenceMetadata.mockResolvedValueOnce({
      ...original,
      hostCounts: Object.fromEntries(
        Object.entries(original.hostCounts).reverse(),
      ),
      locations: [...original.locations].reverse(),
    });
    expect(await analyzer.analyze()).toEqual(first);
    expect(original).toEqual(referenceMetadata);
  });

  it('projects only summary fields and sorts alternate host hints', async () => {
    const { analyzer, client } = setup();
    const unexpected = {
      ...referenceMetadata,
      alternateSourceHosts: ['z.example.com', 'a.example.com'],
      rawRows: ['private content'],
      dbPassword: 'private password',
      locations: referenceMetadata.locations.map((entry) => ({
        ...entry,
        value: 'private content',
      })),
    };
    client.getUrlReferenceMetadata.mockResolvedValueOnce(unexpected);
    const data = await analyzer.analyze();
    expect(data.alternateSourceHosts).toEqual([
      'a.example.com',
      'z.example.com',
    ]);
    expect(JSON.stringify(data)).not.toContain('private');
  });

  it('propagates malformed metadata errors', async () => {
    const { analyzer, client } = setup();
    const error = new WpCliOutputError('eval (URL reference metadata)');
    client.getUrlReferenceMetadata.mockRejectedValueOnce(error);
    await expect(analyzer.analyze()).rejects.toBe(error);
  });
});
