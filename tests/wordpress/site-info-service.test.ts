import { describe, expect, it, vi } from 'vitest';
import { SiteInfoService } from '../../src/wordpress/site-info-service.js';
import {
  WpCliClient,
  type WpSiteMetadata,
} from '../../src/wordpress/wp-cli-client.js';
import {
  ProcessExecutionError,
  type runProcess,
} from '../../src/utils/process-runner.js';

function setup(isMultisite = false) {
  const metadata: WpSiteMetadata = {
    isMultisite,
    siteUrl: 'https://example.test/wordpress',
    homeUrl: 'https://example.test',
    tablePrefix: isMultisite ? 'custom_2_' : 'custom_',
  };
  const client = {
    getCoreVersion: vi.fn<WpCliClient['getCoreVersion']>().mockResolvedValue({
      version: '6.8.3',
    }),
    getCliInfo: vi.fn<WpCliClient['getCliInfo']>().mockResolvedValue({
      wp_cli_version: '2.12.0',
      php_version: '8.3.0',
      php_binary_path: '/usr/bin/php',
      system_os: 'Linux',
    }),
    getSiteMetadata: vi
      .fn<WpCliClient['getSiteMetadata']>()
      .mockResolvedValue(metadata),
  };
  return { client, metadata, service: new SiteInfoService(client) };
}

describe('SiteInfoService', () => {
  it.each([false, true])(
    'gathers all site fields with multisite=%s',
    async (isMultisite) => {
      const { client, metadata, service } = setup(isMultisite);
      const info = await service.getSiteInfo();
      expect(info).toEqual({
        wordpressVersion: '6.8.3',
        ...metadata,
        phpVersion: '8.3.0',
        wpCliVersion: '2.12.0',
      });
      expect(JSON.parse(JSON.stringify(info))).toEqual(info);
      expect(client.getCoreVersion).toHaveBeenCalledExactlyOnceWith();
      expect(client.getCliInfo).toHaveBeenCalledExactlyOnceWith();
      expect(client.getSiteMetadata).toHaveBeenCalledExactlyOnceWith();
    },
  );

  it.each(['getCoreVersion', 'getCliInfo', 'getSiteMetadata'] as const)(
    'propagates %s failures instead of returning incomplete site information',
    async (method) => {
      const { client, service } = setup();
      const error = new ProcessExecutionError(
        'NON_ZERO_EXIT',
        {
          stdout: '',
          stderr: 'Unable to read installation',
          exitCode: 1,
          signal: null,
        },
        new Error('failed'),
      );
      client[method].mockRejectedValueOnce(error);
      await expect(service.getSiteInfo()).rejects.toBe(error);
    },
  );

  it('assembles site info through the real adapter using mocked WP-CLI responses', async () => {
    const { metadata } = setup();
    const runner = vi
      .fn<typeof runProcess>()
      .mockImplementation(async (_executable, args) => {
        let stdout: string;
        if (args[0] === 'core' && args[1] === 'version') {
          stdout = '6.8.3\n';
        } else if (args[0] === 'cli' && args[1] === 'info') {
          stdout = JSON.stringify({
            wp_cli_version: '2.12.0',
            php_version: '8.3.0',
            php_binary_path: '/usr/bin/php',
            system_os: 'Linux',
          });
        } else if (args[0] === 'eval') {
          stdout = JSON.stringify(metadata);
        } else {
          throw new Error('Unexpected WP-CLI command');
        }
        return { stdout, stderr: '', exitCode: 0, signal: null };
      });
    const service = new SiteInfoService(
      new WpCliClient({ wordpressPath: '/site' }, runner),
    );
    await expect(service.getSiteInfo()).resolves.toEqual({
      wordpressVersion: '6.8.3',
      ...metadata,
      phpVersion: '8.3.0',
      wpCliVersion: '2.12.0',
    });
    expect(runner).toHaveBeenCalledTimes(3);
  });
});
