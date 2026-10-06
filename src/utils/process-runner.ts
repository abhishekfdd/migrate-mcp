import { execFile } from 'node:child_process';

export interface ProcessResult {
  stdout: string;
  stderr: string;
  /** Null when the process could not start or was terminated by a signal. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface ProcessOptions {
  /** Positive integer in milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
}

export type ProcessErrorCode =
  | 'EXECUTABLE_NOT_FOUND'
  | 'TIMEOUT'
  | 'NON_ZERO_EXIT'
  | 'SIGNAL_TERMINATION'
  | 'OUTPUT_LIMIT'
  | 'SPAWN_ERROR';

export class ProcessExecutionError extends Error {
  constructor(
    public readonly code: ProcessErrorCode,
    public readonly result: ProcessResult,
    cause: unknown,
  ) {
    super(`Process execution failed: ${code}`, { cause });
    this.name = 'ProcessExecutionError';
  }
}

/**
 * Runs a caller-selected executable directly, without shell parsing.
 * Callers must choose trusted executables and validate their allowed arguments;
 * this utility does not enforce read-only behavior of the program being run.
 * Output is UTF-8, bounded to 1 MiB per stream. Stdin is closed immediately.
 * A timeout forcefully terminates the direct child, not its descendants.
 */
export async function runProcess(
  executable: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  ) {
    throw new RangeError('timeoutMs must be an integer from 1 to 2147483647');
  }

  try {
    return await new Promise<ProcessResult>((resolve, reject) => {
      const child = execFile(
        executable,
        args,
        {
          shell: false,
          encoding: 'utf8',
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const result: ProcessResult = {
            stdout,
            stderr,
            // Node may use a negative OS error number when spawning fails.
            exitCode:
              child.exitCode !== null && child.exitCode >= 0
                ? child.exitCode
                : null,
            signal: child.signalCode,
          };

          if (!error) {
            resolve(result);
            return;
          }

          let code: ProcessErrorCode;
          if (error.code === 'ENOENT') {
            code = 'EXECUTABLE_NOT_FOUND';
          } else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            code = 'OUTPUT_LIMIT';
          } else if (error.killed && error.signal === 'SIGKILL') {
            code = 'TIMEOUT';
          } else if (error.signal) {
            code = 'SIGNAL_TERMINATION';
          } else if (typeof error.code === 'number' && error.code > 0) {
            code = 'NON_ZERO_EXIT';
          } else {
            code = 'SPAWN_ERROR';
          }

          reject(new ProcessExecutionError(code, result, error));
        },
      );
      child.stdin?.end();
    });
  } catch (error) {
    if (error instanceof ProcessExecutionError) {
      throw error;
    }
    // Normalize synchronous launch errors, such as invalid executable names.
    throw new ProcessExecutionError(
      'SPAWN_ERROR',
      { stdout: '', stderr: '', exitCode: null, signal: null },
      error,
    );
  }
}
