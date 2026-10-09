import type { MigrationPlan } from '../../src/migration/migration-plan.js';

/** Constructed planner outputs: MCP tests never run the planning engine. */
export function migrationPlan(
  readiness: MigrationPlan['readiness'] = 'ready',
): MigrationPlan {
  const result: MigrationPlan = {
    kind: 'migration-plan',
    executionPerformed: false,
    readiness,
    summary: { blockerCount: 0, warningCount: 0, stepCount: 2 },
    blockers: [],
    warnings: [],
    phases: [
      {
        id: 'preflight',
        name: 'Preflight',
        order: 1,
        description: 'Review prerequisites.',
        dependsOn: [],
        steps: [
          {
            id: 'confirm-scope-and-recovery',
            title: 'Confirm scope',
            description: 'Review scope and recovery prerequisites.',
            category: 'environment',
            risk: 'low',
            automated: false,
            requiresConfirmation: true,
            reason: 'Explicit scope is required.',
          },
        ],
      },
      {
        id: 'validation',
        name: 'Validation',
        order: 2,
        description: 'Plan acceptance checks.',
        dependsOn: ['preflight'],
        steps: [
          {
            id: 'validate-approved-migration',
            title: 'Plan validation',
            description:
              'Perform checks after a separately approved migration.',
            category: 'validation',
            risk: 'low',
            automated: true,
            requiresConfirmation: true,
            reason: 'Acceptance criteria are required.',
          },
        ],
      },
    ],
    validationChecks: [
      {
        id: 'validate-site-configuration',
        title: 'Validate configuration',
        description: 'Verify approved site/home configuration.',
        category: 'environment',
      },
    ],
    unresolvedDecisions: [],
    manualReviewItems: [],
  };
  if (readiness !== 'ready') {
    result.phases.splice(1, 0, {
      id: 'users',
      name: 'Users',
      order: 2,
      description: 'Review identities.',
      dependsOn: ['preflight'],
      steps: [
        {
          id: 'define-user-id-strategy',
          title: 'Define identity strategy',
          description: 'Choose an identity strategy before migration.',
          category: 'users',
          risk: 'high',
          automated: false,
          requiresConfirmation: true,
          reason: 'Comparison reported USER_ID_RANGE_OVERLAP.',
          affectedObjects: ['authors', 'editors'],
        },
      ],
    });
    result.phases[2]!.order = 3;
    result.phases[2]!.dependsOn = ['preflight', 'users'];
    result.warnings = [
      {
        code: 'USER_ID_RANGE_OVERLAP',
        severity: 'high',
        category: 'user',
        message: 'Ranges overlap.',
        sourceConflictCode: 'USER_ID_RANGE_OVERLAP',
      },
      {
        code: 'ANALYZER_WARNING',
        severity: 'warning',
        category: 'user',
        message: 'Metadata review needed.',
        sourceConflictCode: 'ANALYZER_WARNING',
        sourceAnalyzerCode: 'LARGE_USERMETA_SETS',
        side: 'source',
        affectedObjects: ['authors', 'editors'],
      },
    ];
    result.unresolvedDecisions = [
      {
        id: 'choose-user-id-strategy',
        question: 'How should source identities be handled?',
        reason: 'ID ranges overlap.',
        options: ['design-explicit-user-mapping', 'assess-offset-strategy'],
        affectedObjects: ['authors', 'editors'],
      },
    ];
    result.validationChecks.push({
      id: 'validate-user-mapping',
      title: 'Validate identity handling',
      description: 'Verify approved identities and references.',
      category: 'users',
    });
    result.manualReviewItems = ['define-user-id-strategy'];
    result.summary = { blockerCount: 0, warningCount: 2, stepCount: 3 };
  }
  if (readiness === 'blocked') {
    result.blockers = [
      {
        code: 'UNSUPPORTED_IDENTITY_POLICY',
        severity: 'blocking',
        category: 'user',
        message: 'Identity policy requires intervention.',
        sourceConflictCode: 'UNSUPPORTED_IDENTITY_POLICY',
      },
    ];
    result.summary.blockerCount = 1;
  }
  return result;
}
