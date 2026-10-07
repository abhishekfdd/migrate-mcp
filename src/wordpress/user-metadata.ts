import { z } from 'zod';

export const largeMetaSetThreshold = 1000;

const count = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const optionalCount = count.nullish().transform((value) => value ?? undefined);
const siteId = count.pipe(z.number().positive());

export const userMetadataSchema = z
  .object({
    totalUsers: count,
    minUserId: optionalCount,
    maxUserId: optionalCount,
    multisite: z.boolean(),
    roleSiteId: siteId,
    siteUserCount: count,
    roleCounts: z.record(z.string().min(1), count),
    usersWithoutRole: count,
    duplicateEmailCount: count,
    duplicateLoginCount: count,
    siteMemberships: z.array(z.object({ siteId, userCount: count })).optional(),
    usersWithLargeMetaSets: optionalCount,
    orphanedUsermetaRows: optionalCount,
    unknownSiteCapabilityRows: count,
    unexpectedCapabilityRows: count,
    duplicateCapabilityRows: count,
    malformedCapabilityUsers: count,
    nonBooleanCapabilityUsers: count,
  })
  .superRefine((value, ctx) => {
    const invalid = (message: string) =>
      ctx.addIssue({ code: 'custom', message });
    if (value.totalUsers === 0) {
      if (value.minUserId !== undefined || value.maxUserId !== undefined)
        invalid('Empty users must have no ID range');
    } else if (
      value.minUserId === undefined ||
      value.maxUserId === undefined ||
      value.minUserId > value.maxUserId
    ) {
      invalid('Non-empty users must have an ordered ID range');
    }
    if (
      value.siteUserCount > value.totalUsers ||
      (!value.multisite && value.siteUserCount !== value.totalUsers)
    )
      invalid('Invalid site user count');
    for (const n of [
      value.usersWithoutRole,
      value.malformedCapabilityUsers,
      value.nonBooleanCapabilityUsers,
      ...Object.values(value.roleCounts),
    ]) {
      if (n > value.siteUserCount) invalid('Role counts exceed site users');
    }
    for (const n of [
      value.duplicateEmailCount,
      value.duplicateLoginCount,
      value.usersWithLargeMetaSets ?? 0,
    ]) {
      if (n > value.totalUsers) invalid('User counts exceed total users');
    }
    const memberships = value.siteMemberships;
    if (value.multisite) {
      if (
        !memberships?.length ||
        new Set(memberships.map((site) => site.siteId)).size !==
          memberships.length
      )
        invalid('Multisite requires unique site memberships');
      if (
        memberships?.find((site) => site.siteId === value.roleSiteId)
          ?.userCount !== value.siteUserCount
      )
        invalid('Active site membership must match site user count');
      if (memberships?.some((site) => site.userCount > value.totalUsers))
        invalid('Membership count exceeds total users');
    } else if (memberships !== undefined) {
      invalid(
        'Single-site installations must not return multisite memberships',
      );
    }
  });

export type WpUserMetadata = z.infer<typeof userMetadataSchema>;
