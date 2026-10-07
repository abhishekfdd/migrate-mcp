import { describe, expect, it, vi } from 'vitest';
import {
  WpCliClient,
  WpCliOutputError,
} from '../../src/wordpress/wp-cli-client.js';
import { userMetadataPhp } from '../../src/wordpress/user-inspection.js';
import {
  ProcessExecutionError,
  type runProcess,
} from '../../src/utils/process-runner.js';

const metadata = {
  totalUsers: '4',
  minUserId: '1',
  maxUserId: '9007199254740991',
  multisite: false,
  roleSiteId: '1',
  siteUserCount: '4',
  roleCounts: { subscriber: '2', administrator: '1' },
  usersWithoutRole: '1',
  duplicateEmailCount: '1',
  duplicateLoginCount: '0',
  usersWithLargeMetaSets: '1',
  orphanedUsermetaRows: '2',
  unknownSiteCapabilityRows: '0',
  unexpectedCapabilityRows: '0',
  duplicateCapabilityRows: '0',
  malformedCapabilityUsers: '0',
  nonBooleanCapabilityUsers: '0',
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
  return { client, runner };
}

describe('WP-CLI user metadata', () => {
  it('uses static read-only inspection and parses counts and boundary IDs as numbers', async () => {
    const { client, runner } = setup(JSON.stringify(metadata));
    const result = await client.getUserMetadata();
    expect(result).toMatchObject({
      totalUsers: 4,
      minUserId: 1,
      maxUserId: Number.MAX_SAFE_INTEGER,
      roleSiteId: 1,
      siteUserCount: 4,
      roleCounts: { subscriber: 2, administrator: 1 },
      duplicateEmailCount: 1,
      duplicateLoginCount: 0,
      usersWithLargeMetaSets: 1,
      orphanedUsermetaRows: 2,
    });
    expect(runner).toHaveBeenCalledExactlyOnceWith(
      '/tools/wp',
      [
        'eval',
        userMetadataPhp,
        '--path=/site; --exec=untrusted',
        '--no-color',
        '--skip-plugins',
        '--skip-themes',
        '--skip-packages',
      ],
      { timeoutMs: 5000 },
    );
    expect(userMetadataPhp).toContain(
      "$wpdb->get_blog_prefix($id) . 'capabilities'",
    );
    expect(userMetadataPhp).toContain('COUNT(DISTINCT m.user_id)');
    expect(userMetadataPhp).toContain('LIMIT 500');
    expect(userMetadataPhp).toContain("'allowed_classes' => false");
    expect(userMetadataPhp).not.toMatch(
      /untrusted|SELECT \*|user_pass|user_activation_key|session_tokens|application_passwords|\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/,
    );
  });

  it('handles zero users and null ID bounds', async () => {
    const { client } = setup(
      JSON.stringify({
        ...metadata,
        totalUsers: '0',
        minUserId: null,
        maxUserId: null,
        siteUserCount: 0,
        roleCounts: {},
        usersWithoutRole: 0,
        duplicateEmailCount: 0,
        usersWithLargeMetaSets: 0,
      }),
    );
    const result = await client.getUserMetadata();
    expect(result.totalUsers).toBe(0);
    expect(result.minUserId).toBeUndefined();
    expect(result.maxUserId).toBeUndefined();
    expect(result.roleCounts).toEqual({});
  });

  it('accepts overlapping multisite memberships independently of network totals', async () => {
    const { client } = setup(
      JSON.stringify({
        ...metadata,
        multisite: true,
        roleSiteId: '2',
        siteUserCount: '3',
        siteMemberships: [
          { siteId: '1', userCount: '4' },
          { siteId: '2', userCount: '3' },
        ],
      }),
    );
    const result = await client.getUserMetadata();
    expect(result.totalUsers).toBe(4);
    expect(result.siteMemberships).toEqual([
      { siteId: 1, userCount: 4 },
      { siteId: 2, userCount: 3 },
    ]);
  });

  it.each([null, undefined])(
    'allows unavailable optional usermeta counts (%s)',
    async (missing) => {
      const { client } = setup(
        JSON.stringify({
          ...metadata,
          orphanedUsermetaRows: missing,
          usersWithLargeMetaSets: missing,
        }),
      );
      const result = await client.getUserMetadata();
      expect(result.orphanedUsermetaRows).toBeUndefined();
      expect(result.usersWithLargeMetaSets).toBeUndefined();
    },
  );

  it('strips unknown sensitive response fields', async () => {
    const { client } = setup(
      JSON.stringify({
        ...metadata,
        user_pass: 'private-hash',
        user_activation_key: 'private-key',
        session_tokens: 'private-session',
        application_passwords: 'private-password',
        users: [{ user_email: 'private-email', user_login: 'private-login' }],
      }),
    );
    expect(JSON.stringify(await client.getUserMetadata())).not.toContain(
      'private',
    );
  });

  it.each([
    'not json',
    'null',
    '[]',
    '{}',
    ...[
      { totalUsers: -1 },
      { totalUsers: '4 users' },
      { totalUsers: true },
      { minUserId: 1.5 },
      { maxUserId: '9007199254740992' },
      { maxUserId: null },
      { minUserId: 20, maxUserId: 10 },
      { totalUsers: 0, siteUserCount: 0 },
      { roleCounts: [] },
      { roleCounts: { administrator: 'many' } },
      { roleCounts: { subscriber: 5 } },
      { roleSiteId: 0 },
      { siteUserCount: 5 },
      { siteUserCount: 3 },
      { usersWithoutRole: 5 },
      { duplicateEmailCount: 5 },
      { duplicateLoginCount: -1 },
      { usersWithLargeMetaSets: 5 },
      { orphanedUsermetaRows: '2 rows' },
      { multisite: 'true' },
      { multisite: true },
      { multisite: true, siteMemberships: [] },
      { siteMemberships: [{ siteId: 1, userCount: 4 }] },
      {
        multisite: true,
        siteMemberships: [
          { siteId: 1, userCount: 4 },
          { siteId: 1, userCount: 4 },
        ],
      },
      { multisite: true, siteMemberships: [{ siteId: 2, userCount: 4 }] },
      { multisite: true, siteMemberships: [{ siteId: 1, userCount: 5 }] },
      { unknownSiteCapabilityRows: null },
      { unexpectedCapabilityRows: false },
      { malformedCapabilityUsers: 5 },
      { nonBooleanCapabilityUsers: 5 },
    ].map((invalid) => JSON.stringify({ ...metadata, ...invalid })),
  ])('rejects malformed or inconsistent metadata %s', async (stdout) => {
    const { client } = setup(stdout);
    await expect(client.getUserMetadata()).rejects.toBeInstanceOf(
      WpCliOutputError,
    );
  });

  it('propagates required query/process failures instead of returning empty counts', async () => {
    const { client, runner } = setup('');
    const error = new ProcessExecutionError(
      'NON_ZERO_EXIT',
      { stdout: '', stderr: 'failed', exitCode: 1, signal: null },
      new Error('failed'),
    );
    runner.mockRejectedValueOnce(error);
    await expect(client.getUserMetadata()).rejects.toBe(error);
  });
});
