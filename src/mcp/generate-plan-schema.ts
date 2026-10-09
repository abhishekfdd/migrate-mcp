import { z } from 'zod';
import type {
  MigrationPlan,
  MigrationStep,
  MigrationPlanIssue,
  MigrationPhase,
  ValidationCheck,
  MigrationDecision,
} from '../migration/migration-plan.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const strings = z.array(z.string());
const category = z.enum([
  'environment',
  'database',
  'content',
  'taxonomy',
  'users',
  'media',
  'urls',
  'validation',
]);
const phaseId = z.enum([
  'preflight',
  'environment-preparation',
  'schema-and-plugin-preparation',
  'users',
  'content-and-taxonomies',
  'custom-tables',
  'media',
  'url-rewrite',
  'validation',
]);
const step = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  category,
  risk: z.enum(['low', 'medium', 'high']),
  automated: z.boolean(),
  requiresConfirmation: z.boolean(),
  reason: z.string(),
  affectedObjects: strings.optional(),
} satisfies Record<keyof MigrationStep, z.ZodType>);
const issue = z.object({
  code: z.string(),
  severity: z.enum(['info', 'warning', 'high', 'blocking']),
  category: z.enum([
    'environment',
    'content-type',
    'taxonomy',
    'database',
    'user',
    'media',
    'url',
  ]),
  message: z.string(),
  sourceConflictCode: z.string(),
  sourceAnalyzerCode: z.string().optional(),
  side: z.enum(['source', 'target']).optional(),
  affectedObjects: strings.optional(),
} satisfies Record<keyof MigrationPlanIssue, z.ZodType>);
const phase = z.object({
  id: phaseId,
  name: z.string(),
  order: count.positive(),
  description: z.string(),
  dependsOn: z.array(phaseId),
  steps: z.array(step),
} satisfies Record<keyof MigrationPhase, z.ZodType>);
const check = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  category,
} satisfies Record<keyof ValidationCheck, z.ZodType>);
const decision = z.object({
  id: z.string(),
  question: z.string(),
  reason: z.string(),
  options: strings.optional(),
  affectedObjects: strings.optional(),
} satisfies Record<keyof MigrationDecision, z.ZodType>);

// Validate/project the existing domain shape. Readiness, ordering, dependencies,
// and automation potential belong to the planner and are not recomputed here.
export const migrationPlanOutputSchema = z.object({
  kind: z.literal('migration-plan'),
  executionPerformed: z.literal(false),
  readiness: z.enum(['ready', 'ready_with_warnings', 'blocked']),
  summary: z.object({
    blockerCount: count,
    warningCount: count,
    stepCount: count,
  }),
  blockers: z.array(issue),
  warnings: z.array(issue),
  phases: z.array(phase),
  validationChecks: z.array(check),
  unresolvedDecisions: z.array(decision),
  manualReviewItems: strings,
} satisfies Record<keyof MigrationPlan, z.ZodType>);
