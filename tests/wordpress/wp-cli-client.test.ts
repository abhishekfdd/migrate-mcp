import { describe, expect, it, vi } from 'vitest';
import {
  ProcessExecutionError,
  type runProcess,
} from '../../src/utils/process-runner.js';
import {
  WpCliClient,
  WpCliOutputError,
} from '../../src/wordpress/wp-cli-client.js';

function setup(stdout: string) {
  const runner = vi.fn<typeof runProcess>().mockResolvedValue({
    stdout,
    stderr: '',
    exitCode: 0,
    signal: null,
  });
  const client = new WpCliClient({ wordpressPath: '/sites/wordpress' }, runner);
  return { runner, client };
}

const commonArgs = [
  '--path=/sites/wordpress',
  '--no-color',
  '--skip-plugins',
  '--skip-themes',
  '--skip-packages',
];

// WP-CLI uses snake_case keys and may return false/null for unavailable paths.
const cliInfo = {
  system_os: 'Linux x86_64',
  shell: false,
  php_binary_path: '/usr/bin/php',
  php_version: '8.3.0',
  php_ini_used: false,
  wp_cli_dir_path: 'phar://wp-cli.phar/vendor/wp-cli/wp-cli',
  wp_cli_packages_dir_path: null,
  global_config_path: '',
  project_config_path: '/sites/wordpress/wp-cli.yml',
  wp_cli_version: '2.12.0',
};

describe('WpCliClient', () => {
  it.each(['6.8.3', '6.9-beta1-60000', '7.0-RC1'])(
    'reads core version %s using the default binary',
    async (version) => {
      const { runner, client } = setup(`${version}\r\n`);
      await expect(client.getCoreVersion()).resolves.toEqual({ version });
      expect(runner).toHaveBeenCalledExactlyOnceWith(
        'wp',
        ['core', 'version', ...commonArgs],
        {},
      );
    },
  );

  it('requests JSON CLI info and returns validated environment details', async () => {
    const { runner, client } = setup(JSON.stringify(cliInfo));
    await expect(client.getCliInfo()).resolves.toEqual(cliInfo);
    expect(runner).toHaveBeenCalledExactlyOnceWith(
      'wp',
      ['cli', 'info', '--format=json', ...commonArgs],
      {},
    );
  });

  it('keeps a custom binary and unusual WordPress path as separate arguments', async () => {
    const { runner } = setup('6.8.3\n');
    const path = '/sites/my site; $(echo example) --require=other.php';
    const client = new WpCliClient(
      { wordpressPath: path, wpBinaryPath: '/tools/my wp', timeoutMs: 5000 },
      runner,
    );
    await client.getCoreVersion();
    expect(runner).toHaveBeenCalledExactlyOnceWith(
      '/tools/my wp',
      ['core', 'version', `--path=${path}`, ...commonArgs.slice(1)],
      { timeoutMs: 5000 },
    );
  });

  it.each(['', ' \n', 'warning\n6.8.3', 'not-a-version'])(
    'rejects invalid core version output %j',
    async (stdout) => {
      const { client } = setup(stdout);
      await expect(client.getCoreVersion()).rejects.toBeInstanceOf(
        WpCliOutputError,
      );
    },
  );

  it.each([
    'not json',
    'null',
    '[]',
    '{}',
    JSON.stringify({ ...cliInfo, wp_cli_version: 42 }),
  ])('rejects invalid CLI info output %s', async (stdout) => {
    const { client } = setup(stdout);
    await expect(client.getCliInfo()).rejects.toBeInstanceOf(WpCliOutputError);
  });

  it('accepts newer CLI fields without requiring them in older output', async () => {
    const { client } = setup(
      JSON.stringify({
        ...cliInfo,
        php_memory_limit: '512M',
        sql_modes: ['STRICT_TRANS_TABLES'],
        future_field: { value: true },
      }),
    );
    await expect(client.getCliInfo()).resolves.toEqual({
      ...cliInfo,
      php_memory_limit: '512M',
      sql_modes: ['STRICT_TRANS_TABLES'],
    });
  });

  it.each(['getCoreVersion', 'getCliInfo', 'getSiteMetadata'] as const)(
    'preserves process execution errors from %s',
    async (method) => {
      const { runner, client } = setup('');
      const error = new ProcessExecutionError(
        'NON_ZERO_EXIT',
        {
          stdout: '',
          stderr: 'WordPress not found',
          exitCode: 1,
          signal: null,
        },
        new Error('failed'),
      );
      runner.mockRejectedValueOnce(error);
      await expect(client[method]()).rejects.toBe(error);
    },
  );

  it('reads site metadata with fixed PHP and keeps the path outside the code', async () => {
    const metadata = {
      isMultisite: true,
      siteUrl: 'https://example.test/wordpress',
      homeUrl: 'https://example.test',
      tablePrefix: 'custom_2_',
    };
    const { runner } = setup(JSON.stringify(metadata));
    const path = '/sites/example\' "; echo injected; --exec=other';
    const client = new WpCliClient({ wordpressPath: path }, runner);
    await expect(client.getSiteMetadata()).resolves.toEqual(metadata);
    expect(runner).toHaveBeenCalledExactlyOnceWith(
      'wp',
      [
        'eval',
        `global $wpdb;
echo wp_json_encode(array(
    'isMultisite' => (bool) is_multisite(),
    'siteUrl' => get_option('siteurl'),
    'homeUrl' => get_option('home'),
    'tablePrefix' => $wpdb->prefix
));`,
        `--path=${path}`,
        ...commonArgs.slice(1),
      ],
      {},
    );
  });

  it('accepts a single site with local URLs and an empty table prefix', async () => {
    const metadata = {
      isMultisite: false,
      siteUrl: 'http://localhost:8080/wp/',
      homeUrl: 'http://localhost:8080/',
      tablePrefix: '',
    };
    const { client } = setup(JSON.stringify(metadata));
    await expect(client.getSiteMetadata()).resolves.toEqual(metadata);
  });

  it.each([
    'not json',
    'null',
    '[]',
    '{}',
    ...[
      { isMultisite: 'false' },
      { siteUrl: false },
      { homeUrl: '' },
      { homeUrl: 'javascript:alert(1)' },
      { tablePrefix: 'invalid-prefix' },
    ].map((invalid) =>
      JSON.stringify({
        isMultisite: false,
        siteUrl: 'https://example.test/wp',
        homeUrl: 'https://example.test',
        tablePrefix: 'wp_',
        ...invalid,
      }),
    ),
  ])('rejects malformed site metadata %s', async (stdout) => {
    const { client } = setup(stdout);
    await expect(client.getSiteMetadata()).rejects.toBeInstanceOf(
      WpCliOutputError,
    );
  });

  it.each(['', '   ', 'invalid\0path'])(
    'rejects an invalid path %j',
    (wordpressPath) => {
      const { runner } = setup('');
      expect(() => new WpCliClient({ wordpressPath }, runner)).toThrow(
        TypeError,
      );
      expect(runner).not.toHaveBeenCalled();
    },
  );

  it.each(['', '   ', 'invalid\0binary'])(
    'rejects an invalid binary %j',
    (wpBinaryPath) => {
      const { runner } = setup('');
      expect(
        () => new WpCliClient({ wordpressPath: '/site', wpBinaryPath }, runner),
      ).toThrow(TypeError);
      expect(runner).not.toHaveBeenCalled();
    },
  );
});
