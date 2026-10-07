import { describe, expect, it, vi } from 'vitest';
import { UserAnalyzer } from '../../src/migration/user-analyzer.js';
import { userMetadataSchema } from '../../src/wordpress/user-metadata.js';
import {
  WpCliClient,
  WpCliOutputError,
} from '../../src/wordpress/wp-cli-client.js';
import type { runProcess } from '../../src/utils/process-runner.js';

const metadata = {
  totalUsers: 4,
  minUserId: 1,
  maxUserId: 50,
  multisite: false,
  roleSiteId: 1,
  siteUserCount: 4,
  roleCounts: { subscriber: 2, editor: 1, administrator: 1 },
  usersWithoutRole: 1,
  duplicateEmailCount: 0,
  duplicateLoginCount: 0,
  usersWithLargeMetaSets: 0,
  orphanedUsermetaRows: 0,
  unknownSiteCapabilityRows: 0,
  unexpectedCapabilityRows: 0,
  duplicateCapabilityRows: 0,
  malformedCapabilityUsers: 0,
  nonBooleanCapabilityUsers: 0,
};

function setup(overrides: Record<string, unknown> = {}) {
  const response = userMetadataSchema.parse({ ...metadata, ...overrides });
  const client = {
    getUserMetadata: vi
      .fn<WpCliClient['getUserMetadata']>()
      .mockResolvedValue(response),
  };
  return { analyzer: new UserAnalyzer(client), client, response };
}

describe('UserAnalyzer', () => {
  it('summarizes single-site users, multiple roles, and users with no role', async () => {
    const { analyzer, client } = setup();
    await expect(analyzer.analyze()).resolves.toEqual({
      totalUsers: 4,
      minUserId: 1,
      maxUserId: 50,
      multisite: false,
      roleSiteId: 1,
      siteUserCount: 4,
      administratorCount: 1,
      roleCounts: { administrator: 1, editor: 1, subscriber: 2 },
      usersWithoutRole: 1,
      duplicateEmailCount: 0,
      duplicateLoginCount: 0,
      usersWithLargeMetaSets: 0,
      warnings: [],
    });
    expect(client.getUserMetadata).toHaveBeenCalledExactlyOnceWith();
  });

  it('omits ID bounds for zero users and preserves zero summaries', async () => {
    const { analyzer } = setup({
      totalUsers: 0,
      siteUserCount: 0,
      minUserId: null,
      maxUserId: null,
      roleCounts: {},
      usersWithoutRole: 0,
    });
    const result = await analyzer.analyze();
    expect(result).toMatchObject({
      totalUsers: 0,
      administratorCount: 0,
      roleCounts: {},
      usersWithoutRole: 0,
      warnings: [],
    });
    expect(result).not.toHaveProperty('minUserId');
    expect(result).not.toHaveProperty('maxUserId');
    expect(result).not.toHaveProperty('siteMemberships');
  });

  it('reports duplicate email and login counts without their values', async () => {
    const { analyzer } = setup({
      duplicateEmailCount: 2,
      duplicateLoginCount: 1,
    });
    const result = await analyzer.analyze();
    expect(result).toMatchObject({
      duplicateEmailCount: 2,
      duplicateLoginCount: 1,
    });
    expect(result.warnings).toEqual([
      { code: 'DUPLICATE_EMAILS', message: expect.any(String), count: 2 },
      { code: 'DUPLICATE_LOGINS', message: expect.any(String), count: 1 },
    ]);
  });

  it('keeps network users separate from overlapping site memberships and active-site roles', async () => {
    const { analyzer } = setup({
      multisite: true,
      roleSiteId: 2,
      siteUserCount: 3,
      siteMemberships: [
        { siteId: 3, userCount: 0 },
        { siteId: 2, userCount: 3 },
        { siteId: 1, userCount: 4 },
      ],
    });
    const result = await analyzer.analyze();
    expect(result).toMatchObject({
      totalUsers: 4,
      roleSiteId: 2,
      siteUserCount: 3,
      usersWithoutRole: 1,
      administratorCount: 1,
    });
    expect(result.siteMemberships).toEqual([
      { siteId: 1, userCount: 4 },
      { siteId: 2, userCount: 3 },
      { siteId: 3, userCount: 0 },
    ]);
  });

  it('reports capability and usermeta risks as fixed messages and numeric summaries', async () => {
    const { analyzer } = setup({
      orphanedUsermetaRows: 7,
      usersWithLargeMetaSets: 2,
      unknownSiteCapabilityRows: 3,
      unexpectedCapabilityRows: 4,
      duplicateCapabilityRows: 2,
      malformedCapabilityUsers: 1,
      nonBooleanCapabilityUsers: 1,
    });
    const result = await analyzer.analyze();
    expect(result.usersWithLargeMetaSets).toBe(2);
    expect(result.warnings.map(({ code, count }) => ({ code, count }))).toEqual(
      [
        { code: 'DUPLICATE_CAPABILITY_ROWS', count: 2 },
        { code: 'LARGE_USERMETA_SETS', count: 2 },
        { code: 'MALFORMED_CAPABILITIES', count: 1 },
        { code: 'NON_BOOLEAN_CAPABILITIES', count: 1 },
        { code: 'ORPHANED_USERMETA', count: 7 },
        { code: 'UNEXPECTED_CAPABILITY_KEYS', count: 4 },
        { code: 'UNKNOWN_SITE_CAPABILITIES', count: 3 },
      ],
    );
  });

  it('warns when optional risk analysis is unavailable instead of implying zero', async () => {
    const { analyzer } = setup({
      orphanedUsermetaRows: undefined,
      usersWithLargeMetaSets: undefined,
    });
    const result = await analyzer.analyze();
    expect(result).not.toHaveProperty('usersWithLargeMetaSets');
    expect(result.warnings).toEqual([
      { code: 'USERMETA_RISKS_UNAVAILABLE', message: expect.any(String) },
    ]);
  });

  it('sorts role summaries deterministically without mutating adapter metadata', async () => {
    const { analyzer, response, client } = setup();
    const original = structuredClone(response);
    const result = await analyzer.analyze();
    expect(Object.keys(result.roleCounts)).toEqual([
      'administrator',
      'editor',
      'subscriber',
    ]);
    expect(response).toEqual(original);
    client.getUserMetadata.mockResolvedValueOnce({
      ...response,
      roleCounts: { editor: 1, administrator: 1, subscriber: 2 },
    });
    await expect(analyzer.analyze()).resolves.toEqual(result);
  });

  it('projects only approved fields even when the service response contains secrets', async () => {
    const { analyzer, client, response } = setup();
    const unexpected = {
      ...response,
      user_pass: 'private-hash',
      user_activation_key: 'private-key',
      session_tokens: 'private-session',
      application_passwords: 'private-password',
      user_email: 'private-email',
      user_login: 'private-login',
    };
    client.getUserMetadata.mockResolvedValueOnce(unexpected);
    expect(JSON.stringify(await analyzer.analyze())).not.toContain('private');
  });

  it('parses numeric ID boundaries through the real adapter with mocked process output', async () => {
    const runner = vi.fn<typeof runProcess>().mockResolvedValue({
      stdout: JSON.stringify({
        ...metadata,
        minUserId: '0',
        maxUserId: '9007199254740991',
      }),
      stderr: '',
      exitCode: 0,
      signal: null,
    });
    const analyzer = new UserAnalyzer(
      new WpCliClient({ wordpressPath: '/site' }, runner),
    );
    await expect(analyzer.analyze()).resolves.toMatchObject({
      minUserId: 0,
      maxUserId: Number.MAX_SAFE_INTEGER,
    });
  });

  it('propagates malformed output failures', async () => {
    const { analyzer, client } = setup();
    const error = new WpCliOutputError('eval (user metadata)');
    client.getUserMetadata.mockRejectedValueOnce(error);
    await expect(analyzer.analyze()).rejects.toBe(error);
  });
});
