import { resolve } from 'node:path';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import {
  SiteComparisonService,
  type SiteComparison,
} from '../migration/site-comparison.js';
import { MigrationPlanner } from '../migration/migration-planner.js';
import type { MigrationPlan } from '../migration/migration-plan.js';
import {
  comparisonInputSchema,
  type SiteComparisonServiceFactory,
} from './compare-sites-tool.js';
import { migrationPlanOutputSchema } from './generate-plan-schema.js';
import { wpCliToolError } from './wp-cli-tool.js';

export type MigrationPlannerFactory = () => Pick<
  MigrationPlanner,
  'generatePlan'
>;

export function registerGeneratePlanTool(
  server: McpServer,
  createComparison: SiteComparisonServiceFactory = () =>
    new SiteComparisonService(),
  createPlanner: MigrationPlannerFactory = () => new MigrationPlanner(),
): void {
  server.registerTool(
    'migration_generate_plan',
    {
      description:
        'Compare two trusted local WordPress installations and generate a read-only migration plan with readiness, blockers, preparation steps, ordered phases, unresolved decisions, risks, and validation requirements. Plan only: no step is executed; automated flags describe potential future automation, not completed work.',
      inputSchema: comparisonInputSchema,
      outputSchema: migrationPlanOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<CallToolResult> => {
      // Match the comparison tool's lexical check; do not probe the filesystem.
      if (resolve(input.sourcePath) === resolve(input.targetPath))
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'SAME_INSTALLATION: Source and target paths normalize to the same path. Choose distinct WordPress installations.',
            },
          ],
        };
      let comparison: SiteComparison;
      try {
        comparison = await createComparison().compare(input);
      } catch (error) {
        // Preserve whole-comparison failure, without guessing the failing side.
        return wpCliToolError(error, 'Site comparison for migration planning');
      }
      let plan: MigrationPlan;
      try {
        plan = createPlanner().generatePlan({ comparison });
      } catch {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'PLANNING_FAILED: A migration plan could not be generated. Review the comparison with migration_compare_sites and check planner/server compatibility before retrying. No migration actions were executed.',
            },
          ],
        };
      }
      const parsed = migrationPlanOutputSchema.safeParse(plan);
      if (!parsed.success)
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'INVALID_PLAN_RESPONSE: The planner returned unexpected data. Check planner/server compatibility before retrying. No migration actions were executed.',
            },
          ],
        };
      return {
        structuredContent: parsed.data,
        content: [{ type: 'text', text: JSON.stringify(parsed.data) }],
      };
    },
  );
}
