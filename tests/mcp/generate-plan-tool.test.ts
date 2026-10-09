import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerGeneratePlanTool,
  type MigrationPlannerFactory,
} from '../../src/mcp/generate-plan-tool.js';
import type { SiteComparisonServiceFactory } from '../../src/mcp/compare-sites-tool.js';
import type {
  SiteComparisonService,
  SiteComparison,
} from '../../src/migration/site-comparison.js';
import type { MigrationPlanner } from '../../src/migration/migration-planner.js';
import type { MigrationPlan } from '../../src/migration/migration-plan.js';
import {
  ProcessExecutionError,
  type ProcessErrorCode,
} from '../../src/utils/process-runner.js';
import { WpCliOutputError } from '../../src/wordpress/wp-cli-client.js';
import {
  identicalComparison,
  comparisonWithRisks,
} from '../fixtures/site-comparison-result.js';
import { migrationPlan } from '../fixtures/migration-plan.js';

describe('migration_generate_plan', () => {
  let client: Client;
  let server: McpServer;
  const compare = vi.fn<SiteComparisonService['compare']>();
  const generatePlan = vi.fn<MigrationPlanner['generatePlan']>();
  const createComparison = vi.fn<SiteComparisonServiceFactory>();
  const createPlanner = vi.fn<MigrationPlannerFactory>();
  const input = { sourcePath: '/source', targetPath: '/target' };
  const call = (args: Record<string, unknown> = input) =>
    client.callTool({ name: 'migration_generate_plan', arguments: args });

  beforeEach(async () => {
    compare.mockReset().mockResolvedValue(identicalComparison());
    generatePlan.mockReset().mockReturnValue(migrationPlan());
    createComparison.mockReset().mockReturnValue({ compare });
    createPlanner.mockReset().mockReturnValue({ generatePlan });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    server = new McpServer({ name: 'plan-test-server', version: '1.0.0' });
    registerGeneratePlanTool(server, createComparison, createPlanner);
    await server.connect(serverTransport);
    client = new Client({ name: 'plan-test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });
  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it('advertises strict two-path input and a read-only plan-only output without invoking services', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: 'migration_generate_plan',
      inputSchema: {
        type: 'object',
        required: ['sourcePath', 'targetPath'],
        additionalProperties: false,
        properties: {
          sourcePath: { type: 'string', minLength: 1 },
          targetPath: { type: 'string', minLength: 1 },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          kind: { const: 'migration-plan' },
          executionPerformed: { const: false },
          phases: { type: 'array' },
          summary: {
            type: 'object',
            properties: { stepCount: { type: 'integer' } },
          },
        },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
    expect(createComparison).not.toHaveBeenCalled();
    expect(createPlanner).not.toHaveBeenCalled();
  });

  it.each(['ready', 'ready_with_warnings', 'blocked'] as const)(
    'preserves the planner result for %s comparisons',
    async (readiness) => {
      const comparison =
        readiness === 'ready' ? identicalComparison() : comparisonWithRisks();
      if (readiness === 'ready_with_warnings')
        comparison.conflicts = comparison.conflicts.filter(
          ({ severity }) => severity !== 'blocking',
        );
      const expected = migrationPlan(readiness);
      compare.mockResolvedValueOnce(comparison);
      generatePlan.mockReturnValueOnce(expected);
      const result = await call();
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(expected);
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify(result.structuredContent) },
      ]);
      expect(compare).toHaveBeenCalledExactlyOnceWith(input);
      expect(generatePlan).toHaveBeenCalledExactlyOnceWith({ comparison });
      expect(generatePlan.mock.calls[0]?.[0].comparison).toBe(comparison);
      expect(createComparison).toHaveBeenCalledExactlyOnceWith();
      expect(createPlanner).toHaveBeenCalledExactlyOnceWith();
    },
  );

  it('passes paths unchanged and waits for comparison before constructing or invoking the planner', async () => {
    let finish!: (comparison: SiteComparison) => void;
    compare.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const args = {
      sourcePath: '/source with spaces; $(literal)',
      targetPath: '/target/./',
    };
    const pending = call(args);
    await vi.waitFor(() =>
      expect(compare).toHaveBeenCalledExactlyOnceWith(args),
    );
    expect(createPlanner).not.toHaveBeenCalled();
    expect(generatePlan).not.toHaveBeenCalled();
    finish(identicalComparison());
    expect((await pending).isError).not.toBe(true);
    expect(generatePlan).toHaveBeenCalledTimes(1);
  });

  it('preserves phase order, dependencies, decisions, validations, flags, and numeric counts', async () => {
    const expected = migrationPlan('ready_with_warnings');
    generatePlan.mockReturnValueOnce(expected);
    const result = (await call()).structuredContent as MigrationPlan;
    expect(result.phases.map(({ id }) => id)).toEqual([
      'preflight',
      'users',
      'validation',
    ]);
    expect(result.phases[2]?.dependsOn).toEqual(['preflight', 'users']);
    expect(result.phases[1]?.steps[0]).toMatchObject({
      risk: 'high',
      automated: false,
      requiresConfirmation: true,
      affectedObjects: ['authors', 'editors'],
    });
    expect(result.phases[2]?.steps[0]?.automated).toBe(true);
    expect(result.executionPerformed).toBe(false);
    expect(result.summary).toEqual({
      blockerCount: 0,
      warningCount: 2,
      stepCount: 3,
    });
    expect(result.unresolvedDecisions).toEqual(expected.unresolvedDecisions);
    expect(result.validationChecks).toEqual(expected.validationChecks);
    expect(result.manualReviewItems).toEqual(['define-user-id-strategy']);
    expect(result.warnings[1]).toMatchObject({
      sourceAnalyzerCode: 'LARGE_USERMETA_SETS',
      side: 'source',
    });
  });

  it('does not infer readiness, create phases, or choose decision options in the MCP layer', async () => {
    compare.mockResolvedValueOnce(comparisonWithRisks());
    generatePlan.mockReturnValueOnce(migrationPlan('ready'));
    const result = (await call()).structuredContent as MigrationPlan;
    expect(result).toEqual(migrationPlan('ready'));
    expect(result.unresolvedDecisions).toEqual([]);
  });

  it('preserves omitted optional fields and informational issue severity', async () => {
    const expected = migrationPlan('ready_with_warnings');
    delete expected.unresolvedDecisions[0]!.options;
    delete expected.unresolvedDecisions[0]!.affectedObjects;
    expected.warnings.push({
      code: 'CONTEXT',
      severity: 'info',
      category: 'environment',
      message: 'Context only.',
      sourceConflictCode: 'CONTEXT',
    });
    expected.summary.warningCount = 3;
    generatePlan.mockReturnValueOnce(expected);
    const result = (await call()).structuredContent as MigrationPlan;
    expect(result).toEqual(expected);
    expect(result.unresolvedDecisions[0]).not.toHaveProperty('options');
    expect(result.warnings[0]).not.toHaveProperty('sourceAnalyzerCode');
  });

  it('preserves deterministic output and does not mutate either service result', async () => {
    const comparison = comparisonWithRisks();
    const expected = migrationPlan('blocked');
    const beforeComparison = structuredClone(comparison);
    const beforePlan = structuredClone(expected);
    compare.mockResolvedValue(comparison);
    generatePlan.mockReturnValue(expected);
    expect(await call()).toEqual(await call());
    expect(comparison).toEqual(beforeComparison);
    expect(expected).toEqual(beforePlan);
  });

  it.each([
    {},
    { sourcePath: '/source' },
    { targetPath: '/target' },
    ...['sourcePath', 'targetPath'].flatMap((key) =>
      ['', ' ', null, 123, false, [], {}, 'relative', '/invalid\0path'].map(
        (value) => ({ ...input, [key]: value }),
      ),
    ),
    ...[
      'execute',
      'dryRun',
      'sql',
      'command',
      'mapping',
      'plan',
      'comparison',
      'options',
    ].map((key) => ({ ...input, [key]: true })),
  ])('rejects invalid input %j before comparison or planning', async (args) => {
    expect((await call(args)).isError).toBe(true);
    expect(createComparison).not.toHaveBeenCalled();
    expect(createPlanner).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();
    expect(generatePlan).not.toHaveBeenCalled();
  });

  it.each([
    '/source',
    '/source/',
    '/source/.',
    '/other/../source',
    '//source//',
  ])('rejects equivalent source/target path %s', async (targetPath) => {
    const result = await call({ ...input, targetPath });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('SAME_INSTALLATION');
    expect(createComparison).not.toHaveBeenCalled();
    expect(createPlanner).not.toHaveBeenCalled();
  });

  it.each([
    ['EXECUTABLE_NOT_FOUND', 'PATH'],
    ['TIMEOUT', 'timed out'],
    ['NON_ZERO_EXIT', 'database connectivity'],
    ['SPAWN_ERROR', 'permissions'],
    ['SIGNAL_TERMINATION', 'signal'],
    ['OUTPUT_LIMIT', 'capture limit'],
  ] satisfies [ProcessErrorCode, string][])(
    'handles comparison %s failures without planning or leaking output',
    async (code, guidance) => {
      compare.mockRejectedValueOnce(
        new ProcessExecutionError(
          code,
          {
            stdout: 'private raw content',
            stderr: 'mysql://root:private-password@db SELECT private',
            exitCode: 1,
            signal: null,
          },
          new Error('private environment secret'),
        ),
      );
      const result = await call();
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.stringify(result)).toContain(code);
      expect(JSON.stringify(result)).toContain(guidance);
      expect(JSON.stringify(result)).not.toContain('private');
      expect(createPlanner).not.toHaveBeenCalled();
      expect(generatePlan).not.toHaveBeenCalled();
    },
  );

  it.each(['source', 'target'])(
    'preserves whole-operation failure on %s analyzer errors',
    async (side) => {
      compare.mockRejectedValueOnce(
        new WpCliOutputError('eval', new Error(`${side} private data`)),
      );
      const result = await call();
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.stringify(result)).toContain('INVALID_WP_CLI_OUTPUT');
      expect(JSON.stringify(result)).not.toContain('private');
      expect(generatePlan).not.toHaveBeenCalled();
    },
  );

  it('sanitizes unexpected comparison and construction failures', async () => {
    compare.mockRejectedValueOnce(new Error('private comparison failure'));
    const result = await call();
    expect(JSON.stringify(result)).toContain('INTERNAL_ERROR');
    expect(JSON.stringify(result)).not.toContain('private');
    createComparison.mockImplementationOnce(() => {
      throw new Error('private constructor failure');
    });
    expect((await call()).isError).toBe(true);
    expect(createPlanner).not.toHaveBeenCalled();
  });

  it.each(['construction', 'planning'])(
    'sanitizes planner %s failure with no partial output',
    async (stage) => {
      const fail = () => {
        throw new Error('private SQL, credentials and stack');
      };
      if (stage === 'construction') createPlanner.mockImplementationOnce(fail);
      else generatePlan.mockImplementationOnce(fail);
      const result = await call();
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.stringify(result)).toContain('PLANNING_FAILED');
      expect(JSON.stringify(result)).toContain('migration_compare_sites');
      expect(JSON.stringify(result)).not.toContain('private');
      expect(compare).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { executionPerformed: true },
    { kind: 'migration-execution' },
    { readiness: 'completed' },
    { summary: { blockerCount: 0, warningCount: 0, stepCount: 'private' } },
    { phases: null },
    {
      phases: [
        {
          id: 'users',
          name: 'private',
          order: 1,
          description: 'private',
          dependsOn: [],
          steps: [{ id: 'private', risk: 'unknown' }],
        },
      ],
    },
  ])(
    'rejects malformed or execution-like planner output without validation leaks',
    async (invalid) => {
      generatePlan.mockReturnValueOnce({
        ...migrationPlan(),
        ...invalid,
      } as unknown as MigrationPlan);
      const result = await call();
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.stringify(result)).toContain('INVALID_PLAN_RESPONSE');
      expect(JSON.stringify(result)).not.toContain('private');
    },
  );

  it('strips raw internals and execution fields throughout the returned plan', async () => {
    const expected = migrationPlan('blocked');
    const info = structuredClone(expected);
    const extras = {
      sql: 'private SQL',
      command: 'private shell',
      rows: ['private content'],
      credentials: 'private secret',
      completed: true,
      status: 'completed',
    };
    Object.assign(info, extras);
    Object.assign(info.summary, extras);
    for (const phase of info.phases) {
      Object.assign(phase, extras);
      phase.steps.forEach((step) => Object.assign(step, extras));
    }
    info.blockers.forEach((issue) => Object.assign(issue, extras));
    info.warnings.forEach((issue) => Object.assign(issue, extras));
    info.unresolvedDecisions.forEach((decision) =>
      Object.assign(decision, extras, { selectedOption: 'private' }),
    );
    info.validationChecks.forEach((check) => Object.assign(check, extras));
    generatePlan.mockReturnValueOnce(info);
    const result = await call();
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(expected);
    expect(JSON.stringify(result)).not.toMatch(
      /private|"completed"|"selectedOption"|"command"|"sql"/,
    );
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ]);
  });
});
