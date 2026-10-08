import {
  compareText,
  sortedSet,
  type MigrationConflict,
  type MigrationCategory,
} from './comparison-model.js';
import type {
  MigrationPlan,
  MigrationPlanningInput,
  MigrationStep,
  MigrationPhase,
  MigrationPhaseId,
  MigrationDecision,
  ValidationCheck,
  PlanningCategory,
} from './migration-plan.js';
import {
  planningRules,
  phaseDefinitions,
  registrationChecks,
  userMappingCheck,
  mediaFilesCheck,
} from './planning-rules.js';

import {
  affected,
  effectiveCode,
  planIssues,
  scopeEvidence,
  positive,
  eitherPositive,
} from './planning-evidence.js';

const categories: Record<
  MigrationCategory,
  { category: PlanningCategory; phase: MigrationPhaseId }
> = {
  environment: { category: 'environment', phase: 'environment-preparation' },
  'content-type': {
    category: 'content',
    phase: 'schema-and-plugin-preparation',
  },
  taxonomy: { category: 'taxonomy', phase: 'schema-and-plugin-preparation' },
  database: { category: 'database', phase: 'schema-and-plugin-preparation' },
  user: { category: 'users', phase: 'users' },
  media: { category: 'media', phase: 'media' },
  url: { category: 'urls', phase: 'url-rewrite' },
};
/** Pure, synchronous planning over a complete comparison; performs no I/O. */
export class MigrationPlanner {
  generatePlan({ comparison: c }: MigrationPlanningInput): MigrationPlan {
    const findings = [...c.conflicts, ...c.warnings];
    const issues = planIssues(findings);
    const steps = new Map<
      string,
      { phase: MigrationPhaseId; step: MigrationStep }
    >();
    const decisions = new Map<string, MigrationDecision>();
    const checks = new Map<string, ValidationCheck>();
    const addStep = (phase: MigrationPhaseId, step: MigrationStep) => {
      steps.set(step.id, { phase, step });
    };
    const check = (item: ValidationCheck) => {
      checks.set(item.id, { ...item });
    };
    const decision = (item: MigrationDecision) => {
      decisions.set(item.id, item);
    };
    addStep('preflight', {
      id: 'confirm-scope-and-recovery',
      title: 'Confirm scope and recovery prerequisites',
      description:
        'Before a separately approved migration, confirm source/target identities, stable analysis evidence, agreed scope, backups, and recovery procedures. This plan does not verify those prerequisites.',
      category: 'environment',
      risk: 'low',
      automated: false,
      requiresConfirmation: true,
      reason:
        'Every migration needs explicit scope and recovery prerequisites.',
    });
    check({
      id: 'validate-site-configuration',
      title: 'Validate site configuration',
      description:
        'Verify site/home URLs and installation identity against the approved destination configuration.',
      category: 'environment',
    });

    const evidence = scopeEvidence(c);
    const handled = new Set<MigrationConflict>();
    for (const rule of planningRules) {
      const matching = findings.filter(
        (finding) =>
          finding.category === rule.category &&
          rule.codes.includes(effectiveCode(finding)),
      );
      const scope = evidence.get(rule.step.id);
      if (!matching.length && !scope) continue;
      matching.forEach((finding) => handled.add(finding));
      const reason = sortedSet([
        ...matching.map(
          (finding) =>
            `Comparison reported ${finding.code}${effectiveCode(finding) === finding.code ? '' : ` (${effectiveCode(finding)})`}.`,
        ),
        ...(scope ? [scope.reason] : []),
      ]).join(' ');
      const objects = sortedSet([
        ...matching.flatMap(affected),
        ...(scope?.objects ?? []),
      ]);
      const objectContext = objects.length ? { affectedObjects: objects } : {};
      addStep(rule.phase, {
        ...rule.step,
        automated: false,
        requiresConfirmation: true,
        reason,
        ...objectContext,
      });
      if (rule.decision)
        decision({
          ...rule.decision,
          ...(rule.decision.options
            ? { options: [...rule.decision.options] }
            : {}),
          reason,
          ...objectContext,
        });
      rule.checks.forEach(check);
    }

    // Unknown risks are visible review work, never silently dropped or promoted
    // to blockers. Wrapper warnings remain distinguishable by analyzer code.
    const reviews = new Map<string, MigrationConflict[]>();
    for (const finding of findings) {
      if (handled.has(finding) || finding.severity === 'info') continue;
      const id = `review-${finding.category}-${encodeURIComponent(effectiveCode(finding))}`;
      reviews.set(id, [...(reviews.get(id) ?? []), finding]);
    }
    for (const [id, group] of reviews) {
      const first = group[0]!;
      const context = categories[first.category];
      addStep(context.phase, {
        id,
        title: 'Review comparison risk',
        description:
          'Review the linked comparison findings and document a resolution or explicit scope decision before migration. The planner cannot infer a safe remedy.',
        category: context.category,
        risk: group.some(
          ({ severity }) => severity === 'high' || severity === 'blocking',
        )
          ? 'high'
          : 'medium',
        automated: false,
        requiresConfirmation: true,
        reason: sortedSet(
          group.map(
            (finding) =>
              `Comparison reported ${finding.code} (${effectiveCode(finding)}).`,
          ),
        ).join(' '),
        affectedObjects: sortedSet(group.flatMap(affected)),
      });
      check({
        id: `validate-${id}`,
        title: 'Validate reviewed risk resolution',
        description: `Verify the documented resolution and approved scope for ${effectiveCode(first)}; the planner has not validated it.`,
        category: context.category,
      });
    }

    const sourceUsers = positive(c.users.metrics.totalUsers.source);
    if (sourceUsers) {
      addStep('users', {
        id: 'prepare-user-identities',
        title: 'Prepare user identities and roles',
        description:
          'Review in-scope user identities, roles, membership boundaries, and authored references before any future transfer. Disjoint ID ranges do not prove accounts are distinct.',
        category: 'users',
        risk: 'medium',
        automated: false,
        requiresConfirmation: true,
        reason: 'The source contains users.',
      });
      check(userMappingCheck);
      if (!decisions.has('choose-user-id-strategy'))
        decision({
          id: 'choose-user-id-strategy',
          question:
            'How should source users be associated with target identities?',
          reason:
            c.users.idRangeStatus === 'unknown'
              ? 'User ID range evidence is incomplete; identity matching has not been performed.'
              : 'ID ranges alone do not establish user identity or an approved migration strategy.',
          options: [
            'design-explicit-user-mapping',
            'review-id-preservation',
            'exclude-users-with-reference-policy',
          ],
        });
    }
    const content = c.contentTypes.volumes
      .filter(({ source }) => positive(source))
      .map(({ name }) => name);
    const terms = c.taxonomies.volumes
      .filter(({ source }) => positive(source))
      .map(({ name }) => name);
    if (content.length) {
      addStep('content-and-taxonomies', {
        id: 'plan-content-transfer',
        title: 'Plan approved content transfer',
        description:
          'Plan transfer of in-scope content and references using approved registration and user strategies; account for retained target data.',
        category: 'content',
        risk: 'low',
        automated: true,
        requiresConfirmation: true,
        reason:
          'Source post counts identify content volume, not configuration conflicts.',
        affectedObjects: sortedSet(content),
      });
      check({
        id: 'validate-content-counts',
        title: 'Validate content counts and relationships',
        description:
          'Reconcile counts by approved post type and verify authorship and relationships, accounting for retained target content and exclusions.',
        category: 'content',
      });
    }
    if (terms.length) {
      addStep('content-and-taxonomies', {
        id: 'plan-term-transfer',
        title: 'Plan approved taxonomy data transfer',
        description:
          'Plan terms and content relationships for approved taxonomies after registration review; no term mapping is calculated.',
        category: 'taxonomy',
        risk: 'low',
        automated: true,
        requiresConfirmation: true,
        reason: 'Source term counts identify migration volume.',
        affectedObjects: sortedSet(terms),
      });
      check({
        id: 'validate-term-counts',
        title: 'Validate term counts and relationships',
        description:
          'Reconcile in-scope taxonomy counts and term relationships against the approved migration scope.',
        category: 'taxonomy',
      });
    }
    if (
      content.length ||
      c.contentTypes.sourceOnly.length ||
      c.contentTypes.shared.length
    )
      check(registrationChecks[0]!);
    if (
      terms.length ||
      c.taxonomies.sourceOnly.length ||
      c.taxonomies.shared.length
    )
      check(registrationChecks[1]!);
    const tables =
      evidence.get('review-custom-table-provisioning')?.objects ?? [];
    if (tables.length) {
      addStep('custom-tables', {
        id: 'plan-approved-table-transfer',
        title: 'Plan approved custom table data transfer',
        description:
          'After ownership and schema decisions, define transfer and reference handling for approved tables only. Do not assume every non-core table belongs to this installation.',
        category: 'database',
        risk: 'high',
        automated: false,
        requiresConfirmation: true,
        reason:
          'Source custom tables are candidates pending an explicit scope decision.',
        affectedObjects: tables,
      });
      check({
        id: 'validate-custom-table-counts',
        title: 'Validate approved custom table data',
        description:
          'Reconcile approved table row counts and relationships using suitable checks; current metadata counts and sizes are estimates, not exact baselines.',
        category: 'database',
      });
    }
    const sourceMedia = positive(c.media.metrics.totalAttachments.source);
    if (sourceMedia) {
      addStep('media', {
        id: 'plan-media-transfer',
        title: 'Plan attachment and storage handling',
        description:
          'Plan approved attachment records, references, and storage handling; choose a storage policy before any copying is considered.',
        category: 'media',
        risk: 'low',
        automated: false,
        requiresConfirmation: true,
        reason: 'The source contains attachments.',
      });
      check({
        id: 'validate-attachment-counts',
        title: 'Validate attachment counts',
        description:
          'Reconcile attachment records and metadata against approved scope, accounting for retained target media.',
        category: 'media',
      });
      check(mediaFilesCheck);
    }
    const externalMedia =
      eitherPositive(c.media.metrics.externalMediaCount) ||
      c.urlReferences.sourceOnlyObservedMediaHosts.length > 0;
    if (externalMedia) {
      const reason =
        'Comparison contains external media indicators or source-only observed media hosts; these are not proof of storage ownership.';
      addStep('media', {
        id: 'review-external-media-policy',
        title: 'Review external media dependencies',
        description:
          'Confirm hosting ownership, availability, and retention/transfer permissions before deciding how external media should be handled.',
        category: 'media',
        risk: 'medium',
        automated: false,
        requiresConfirmation: true,
        reason,
      });
      decision({
        id: 'choose-external-media-policy',
        question:
          'How should external or potentially offloaded media be handled?',
        reason,
        options: [
          'retain-approved-external-storage',
          'design-authorized-storage-transfer',
          'defer-unverified-media',
        ],
      });
      check(mediaFilesCheck);
    }
    if (
      (
        [
          'missingLocalFiles',
          'missingAttachedFileMeta',
          'missingAttachmentMetadata',
          'orphanedAttachments',
        ] as const
      ).some((key) => eitherPositive(c.media.metrics[key]))
    )
      check(mediaFilesCheck);
    const targetData =
      positive(c.users.metrics.totalUsers.target) ||
      positive(c.media.metrics.totalAttachments.target) ||
      c.contentTypes.volumes.some(({ target }) => positive(target)) ||
      c.taxonomies.volumes.some(({ target }) => positive(target)) ||
      c.customTables.targetOnly.length > 0 ||
      c.customTables.shared.length > 0;
    if (
      targetData &&
      (sourceUsers ||
        sourceMedia ||
        content.length > 0 ||
        terms.length > 0 ||
        tables.length > 0)
    )
      decision({
        id: 'choose-existing-target-data-policy',
        question:
          'How should existing target data be retained or reconciled with approved source data?',
        reason:
          'The comparison reports source migration candidates and existing target data; merge or replacement intent is unknown.',
        options: [
          'retain-and-reconcile',
          'design-approved-replacement-scope',
          'defer-unresolved-overlap',
        ],
      });

    addStep('validation', {
      id: 'validate-approved-migration',
      title: 'Plan post-migration validation',
      description:
        'After a separately approved migration, perform the listed checks against the approved scope and resolve discrepancies before acceptance. No checks have run.',
      category: 'validation',
      risk: 'low',
      automated: true,
      requiresConfirmation: true,
      reason: 'Every plan needs validation and acceptance criteria.',
    });
    const phases: MigrationPhase[] = [];
    for (const definition of phaseDefinitions) {
      const items = [...steps.values()]
        .filter(({ phase }) => phase === definition.id)
        .map(({ step }) => step)
        .sort((a, b) => compareText(a.id, b.id));
      if (!items.length) continue;
      // A conservative serial dependency graph avoids unsupported parallelism.
      // Validation explicitly depends on every generated prior phase.
      const dependsOn = phases.map(({ id }) => id);
      phases.push({
        ...definition,
        order: phases.length + 1,
        dependsOn,
        steps: items,
      });
    }
    const blockers = issues.filter(({ severity }) => severity === 'blocking');
    const warnings = issues.filter(({ severity }) => severity !== 'blocking');
    const manualReviewItems = [...steps.values()]
      .filter(({ step }) => !step.automated && step.risk !== 'low')
      .map(({ step }) => step.id)
      .sort(compareText);
    return {
      kind: 'migration-plan',
      executionPerformed: false,
      readiness: blockers.length
        ? 'blocked'
        : warnings.some(({ severity }) => severity !== 'info') ||
            decisions.size ||
            manualReviewItems.length
          ? 'ready_with_warnings'
          : 'ready',
      summary: {
        blockerCount: blockers.length,
        warningCount: warnings.length,
        stepCount: steps.size,
      },
      blockers,
      warnings,
      phases,
      validationChecks: [...checks.values()].sort((a, b) =>
        compareText(a.id, b.id),
      ),
      unresolvedDecisions: [...decisions.values()].sort((a, b) =>
        compareText(a.id, b.id),
      ),
      manualReviewItems,
    };
  }
}
