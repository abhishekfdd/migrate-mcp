import type { UserAnalysis } from './user-analyzer.js';
import type { MediaAnalysis } from './media-analyzer.js';
import {
  addFinding,
  analyzerWarnings,
  compareCounts,
  compareFields,
  compareMetrics,
  publicSiteUrl,
  type ComparisonFindings,
} from './comparison-model.js';

function membershipSummary(memberships: UserAnalysis['siteMemberships']) {
  if (memberships === undefined) return { status: 'unknown' as const };
  let min: number | undefined;
  let max: number | undefined;
  for (const { userCount } of memberships) {
    min = Math.min(min ?? userCount, userCount);
    max = Math.max(max ?? userCount, userCount);
  }
  return {
    status: 'available' as const,
    siteCount: memberships.length,
    sitesWithUsers: memberships.filter(({ userCount }) => userCount > 0).length,
    ...(min === undefined ? {} : { minUserCount: min }),
    ...(max === undefined ? {} : { maxUserCount: max }),
  };
}

export function compareUsers(
  source: UserAnalysis,
  target: UserAnalysis,
  findings: ComparisonFindings,
) {
  let idRangeStatus: 'overlap' | 'disjoint' | 'empty' | 'unknown' = 'unknown';
  if (source.totalUsers === 0 || target.totalUsers === 0)
    idRangeStatus = 'empty';
  else if (
    source.minUserId !== undefined &&
    source.maxUserId !== undefined &&
    target.minUserId !== undefined &&
    target.maxUserId !== undefined
  ) {
    idRangeStatus =
      source.minUserId <= target.maxUserId &&
      target.minUserId <= source.maxUserId
        ? 'overlap'
        : 'disjoint';
  }
  if (idRangeStatus === 'overlap')
    addFinding(findings, {
      code: 'USER_ID_RANGE_OVERLAP',
      category: 'user',
      severity: 'high',
      message:
        'Source and target user ID ranges overlap. Direct ID preservation risks collisions; ranges do not prove that individual IDs collide.',
      details: {
        sourceMin: source.minUserId,
        sourceMax: source.maxUserId,
        targetMin: target.minUserId,
        targetMax: target.maxUserId,
      },
    });
  analyzerWarnings(source.warnings, target.warnings, 'user', findings);
  return {
    idRangeStatus,
    metrics: compareMetrics(source, target, [
      'totalUsers',
      'minUserId',
      'maxUserId',
      'multisite',
      'roleSiteId',
      'siteUserCount',
      'administratorCount',
      'usersWithoutRole',
      'duplicateEmailCount',
      'duplicateLoginCount',
      'usersWithLargeMetaSets',
    ]),
    roles: compareCounts(source.roleCounts, target.roleCounts),
    memberships: {
      source: membershipSummary(source.siteMemberships),
      target: membershipSummary(target.siteMemberships),
    },
  };
}

export function compareMedia(
  source: MediaAnalysis,
  target: MediaAnalysis,
  findings: ComparisonFindings,
) {
  const configuration = (media: MediaAnalysis) => ({
    ...(media.uploadBaseDir === undefined
      ? {}
      : { uploadBaseDir: media.uploadBaseDir }),
    ...(media.uploadBaseUrl === undefined
      ? {}
      : { uploadBaseUrl: publicSiteUrl(media.uploadBaseUrl) }),
    ...(media.usesYearMonthFolders === undefined
      ? {}
      : { usesYearMonthFolders: media.usesYearMonthFolders }),
  });
  const uploads = compareFields(configuration(source), configuration(target), [
    'uploadBaseDir',
    'uploadBaseUrl',
    'usesYearMonthFolders',
  ]);
  if (Object.keys(uploads.differences).length)
    addFinding(findings, {
      code: 'UPLOAD_CONFIGURATION_MISMATCH',
      category: 'media',
      severity: 'warning',
      message:
        'Upload configuration differs. Review destination paths and URL handling; individual files have not been compared.',
      details: { fields: Object.keys(uploads.differences) },
    });
  analyzerWarnings(source.warnings, target.warnings, 'media', findings);
  return {
    uploads,
    metrics: compareMetrics(source, target, [
      'totalAttachments',
      'minAttachmentId',
      'maxAttachmentId',
      'multisite',
      'siteId',
      'missingAttachedFileMeta',
      'missingAttachmentMetadata',
      'missingLocalFiles',
      'checkedLocalFiles',
      'unattachedAttachments',
      'orphanedAttachments',
      'externalMediaCount',
    ]),
    mimeTypes: compareCounts(source.mimeTypeCounts, target.mimeTypeCounts),
    categories: compareCounts(source.categoryCounts, target.categoryCounts),
  };
}
