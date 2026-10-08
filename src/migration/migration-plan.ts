import type {
  MigrationCategory,
  MigrationSeverity,
} from './comparison-model.js';
import type { SiteComparison } from './site-comparison.js';

export interface MigrationPlanningInput {
  comparison: SiteComparison;
}
export type PlanningCategory =
  | 'environment'
  | 'database'
  | 'content'
  | 'taxonomy'
  | 'users'
  | 'media'
  | 'urls'
  | 'validation';
export type MigrationPhaseId =
  | 'preflight'
  | 'environment-preparation'
  | 'schema-and-plugin-preparation'
  | 'users'
  | 'content-and-taxonomies'
  | 'custom-tables'
  | 'media'
  | 'url-rewrite'
  | 'validation';

export interface MigrationStep {
  id: string;
  title: string;
  description: string;
  category: PlanningCategory;
  risk: 'low' | 'medium' | 'high';
  /** Potential future automation only; no step is executed by this planner. */
  automated: boolean;
  requiresConfirmation: boolean;
  reason: string;
  /** Registration keys or table names, not raw analyzer data. */
  affectedObjects?: string[];
}

export interface MigrationPhase {
  id: MigrationPhaseId;
  name: string;
  order: number;
  description: string;
  dependsOn: MigrationPhaseId[];
  steps: MigrationStep[];
}

export interface MigrationPlanIssue {
  code: string;
  severity: MigrationSeverity;
  category: MigrationCategory;
  message: string;
  sourceConflictCode: string;
  sourceAnalyzerCode?: string;
  side?: 'source' | 'target';
  affectedObjects?: string[];
}

export interface ValidationCheck {
  id: string;
  title: string;
  description: string;
  category: PlanningCategory;
}

export interface MigrationDecision {
  id: string;
  question: string;
  reason: string;
  options?: string[];
  affectedObjects?: string[];
}

export interface MigrationPlan {
  kind: 'migration-plan';
  executionPerformed: false;
  readiness: 'ready' | 'ready_with_warnings' | 'blocked';
  summary: { blockerCount: number; warningCount: number; stepCount: number };
  blockers: MigrationPlanIssue[];
  /** Includes informational findings, which alone do not reduce readiness. */
  warnings: MigrationPlanIssue[];
  phases: MigrationPhase[];
  validationChecks: ValidationCheck[];
  unresolvedDecisions: MigrationDecision[];
  /** IDs of non-automatable medium/high-risk steps requiring review. */
  manualReviewItems: string[];
}
