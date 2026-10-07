import { largeMetaSetThreshold } from '../wordpress/user-metadata.js';
import type { WpCliClient } from '../wordpress/wp-cli-client.js';

export interface UserAnalysisWarning {
  code: string;
  message: string;
  count?: number;
}

export interface UserAnalysis {
  /** Existing users across the shared network users table, counted once. */
  totalUsers: number;
  minUserId?: number;
  /** Highest currently assigned ID, not the next auto-increment or historical maximum. */
  maxUserId?: number;
  multisite: boolean;
  /** Role summaries apply only to this active site. */
  roleSiteId: number;
  /** All users on single-site; distinct stored capability-key memberships on multisite. */
  siteUserCount: number;
  administratorCount: number;
  roleCounts: Record<string, number>;
  usersWithoutRole: number;
  /** Extra users beyond the first in each equal-value group, including empty values. */
  duplicateEmailCount: number;
  duplicateLoginCount: number;
  siteMemberships?: { siteId: number; userCount: number }[];
  /** Existing users with more than 1,000 usermeta rows; values are not inspected. */
  usersWithLargeMetaSets?: number;
  warnings: UserAnalysisWarning[];
}

export class UserAnalyzer {
  constructor(private readonly client: Pick<WpCliClient, 'getUserMetadata'>) {}

  async analyze(): Promise<UserAnalysis> {
    const metadata = await this.client.getUserMetadata();
    const warnings: UserAnalysisWarning[] = [];
    const warning = (
      code: string,
      message: string,
      count: number | undefined,
    ) => {
      if (count !== undefined && count > 0)
        warnings.push({ code, message, count });
    };
    warning(
      'DUPLICATE_EMAILS',
      'Users share stored email values; count is extra accounts beyond the first per group.',
      metadata.duplicateEmailCount,
    );
    warning(
      'DUPLICATE_LOGINS',
      'Users share stored login values; count is extra accounts beyond the first per group.',
      metadata.duplicateLoginCount,
    );
    warning(
      'ORPHANED_USERMETA',
      'Usermeta rows reference users absent from the users table.',
      metadata.orphanedUsermetaRows,
    );
    warning(
      'LARGE_USERMETA_SETS',
      `Users have more than ${largeMetaSetThreshold} usermeta rows.`,
      metadata.usersWithLargeMetaSets,
    );
    warning(
      'UNKNOWN_SITE_CAPABILITIES',
      'Capability rows reference site prefixes absent from the registered site list.',
      metadata.unknownSiteCapabilityRows,
    );
    warning(
      'UNEXPECTED_CAPABILITY_KEYS',
      'Capability-like meta keys do not match registered site keys for this prefix.',
      metadata.unexpectedCapabilityRows,
    );
    warning(
      'DUPLICATE_CAPABILITY_ROWS',
      'Extra capability rows exist for the same user and site; active-site roles use the lowest meta ID.',
      metadata.duplicateCapabilityRows,
    );
    warning(
      'MALFORMED_CAPABILITIES',
      'Active-site users have capability values that cannot be safely decoded as arrays.',
      metadata.malformedCapabilityUsers,
    );
    warning(
      'NON_BOOLEAN_CAPABILITIES',
      'Active-site users have non-boolean capability entries; review stored role metadata.',
      metadata.nonBooleanCapabilityUsers,
    );
    if (
      metadata.orphanedUsermetaRows === undefined ||
      metadata.usersWithLargeMetaSets === undefined
    ) {
      warnings.push({
        code: 'USERMETA_RISKS_UNAVAILABLE',
        message:
          'The optional usermeta count analysis was unavailable; orphaned rows and large meta sets may be unassessed.',
      });
    }
    return {
      totalUsers: metadata.totalUsers,
      ...(metadata.minUserId === undefined
        ? {}
        : { minUserId: metadata.minUserId }),
      ...(metadata.maxUserId === undefined
        ? {}
        : { maxUserId: metadata.maxUserId }),
      multisite: metadata.multisite,
      roleSiteId: metadata.roleSiteId,
      siteUserCount: metadata.siteUserCount,
      administratorCount: metadata.roleCounts.administrator ?? 0,
      roleCounts: Object.fromEntries(
        Object.entries(metadata.roleCounts).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      ),
      usersWithoutRole: metadata.usersWithoutRole,
      duplicateEmailCount: metadata.duplicateEmailCount,
      duplicateLoginCount: metadata.duplicateLoginCount,
      ...(metadata.siteMemberships === undefined
        ? {}
        : {
            siteMemberships: metadata.siteMemberships
              .map((site) => ({
                siteId: site.siteId,
                userCount: site.userCount,
              }))
              .sort((a, b) => a.siteId - b.siteId),
          }),
      ...(metadata.usersWithLargeMetaSets === undefined
        ? {}
        : { usersWithLargeMetaSets: metadata.usersWithLargeMetaSets }),
      warnings: warnings.sort((a, b) =>
        a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
      ),
    };
  }
}
