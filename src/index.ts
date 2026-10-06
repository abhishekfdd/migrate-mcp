import { startStdioServer } from './mcp/stdio.js';

try {
  startStdioServer();
} catch (error) {
  process.stderr.write(`Failed to start wp-migrate-mcp: ${String(error)}\n`);
  process.exitCode = 1;
}
