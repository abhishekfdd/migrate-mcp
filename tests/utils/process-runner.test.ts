import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ProcessExecutionError,
  runProcess,
} from '../../src/utils/process-runner.js';

describe('runProcess', () => {
  it('captures stdout, stderr, and the successful exit status', async () => {
    const result = await runProcess(process.execPath, [
      '-e',
      'process.stdout.write("hello 🌍\\n"); process.stderr.write("diagnostic\\n");',
    ]);
    expect(result).toEqual({
      stdout: 'hello 🌍\n',
      stderr: 'diagnostic\n',
      exitCode: 0,
      signal: null,
    });
  });

  it('passes arguments literally without shell expansion or splitting', async () => {
    const args = [
      '',
      'two words',
      '"quoted"',
      "'single quoted'",
      '$(echo expanded)',
      '`echo expanded`',
      '; echo injected',
      '| echo piped',
      '> redirected',
      '$HOME',
      '*.txt',
      'line one\nline two',
    ];
    const result = await runProcess(process.execPath, [
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      '--',
      ...args,
    ]);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it('preserves output and exit code on non-zero exit', async () => {
    await expect(
      runProcess(process.execPath, [
        '-e',
        'process.stdout.write("partial"); process.stderr.write("failed"); process.exitCode = 7;',
      ]),
    ).rejects.toMatchObject({
      name: 'ProcessExecutionError',
      code: 'NON_ZERO_EXIT',
      result: {
        stdout: 'partial',
        stderr: 'failed',
        exitCode: 7,
        signal: null,
      },
    });
  });

  it('reports a missing executable', async () => {
    await expect(
      runProcess(join(tmpdir(), `missing-executable-${randomUUID()}`), []),
    ).rejects.toMatchObject({
      code: 'EXECUTABLE_NOT_FOUND',
      result: { stdout: '', stderr: '', exitCode: null, signal: null },
      cause: { code: 'ENOENT' },
    });
  });

  it('terminates a long-running child on timeout', async () => {
    await expect(
      runProcess(
        process.execPath,
        ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
        { timeoutMs: 150 },
      ),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
      result: { exitCode: null, signal: 'SIGKILL' },
    });
  });

  it('closes stdin so a process waiting for EOF can finish', async () => {
    const result = await runProcess(
      process.execPath,
      [
        '-e',
        'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("eof"));',
      ],
      { timeoutMs: 2000 },
    );
    expect(result.stdout).toBe('eof');
    expect(result.exitCode).toBe(0);
  });

  it('reports excessive output with bounded captured data', async () => {
    const execution = runProcess(process.execPath, [
      '-e',
      'process.stdout.write("x".repeat(1024 * 1024 + 1));',
    ]);
    await expect(execution).rejects.toMatchObject({
      code: 'OUTPUT_LIMIT',
      result: { stdout: 'x'.repeat(1024 * 1024) },
    });
  });

  it.skipIf(process.platform === 'win32')(
    'distinguishes signal termination from a timeout',
    async () => {
      await expect(
        runProcess(process.execPath, [
          '-e',
          'process.kill(process.pid, "SIGTERM");',
        ]),
      ).rejects.toMatchObject({
        code: 'SIGNAL_TERMINATION',
        result: { exitCode: null, signal: 'SIGTERM' },
      });
    },
  );

  it('normalizes invalid executable input to a typed launch error', async () => {
    const execution = runProcess('invalid\0executable', []);
    await expect(execution).rejects.toBeInstanceOf(ProcessExecutionError);
    await expect(execution).rejects.toMatchObject({ code: 'SPAWN_ERROR' });
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648])(
    'rejects invalid timeout %s',
    async (timeoutMs) => {
      await expect(
        runProcess(process.execPath, ['--version'], { timeoutMs }),
      ).rejects.toThrow(RangeError);
    },
  );
});
