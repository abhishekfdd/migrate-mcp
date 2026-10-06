# wp-migrate-mcp

An open-source Model Context Protocol (MCP) server being built to help AI coding
agents analyze, plan, and validate complex WordPress migrations.

**Status: early development.** The server runs over stdio and exposes only an
internal `ping` tool to verify connectivity. It does not invoke WP-CLI or provide
WordPress analysis or migration tools.

## Scope

The initial implementation will be strictly **read-only**: it must not modify
WordPress databases, files, users, posts, media, or configuration. Migration
execution is outside the initial scope.

The planned architecture separates MCP protocol handling from domain services
and puts WP-CLI behind an adapter using safe process execution without arbitrary
shell commands. Services will return structured, JSON-friendly results and have
focused tests. MCP infrastructure uses the official
[TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) v2 server
package. WP-CLI integration will be added in a later step.

The project aims to support MCP clients such as ChatGPT, Codex, Claude Code, and
VS Code-compatible clients. Local clients that support stdio can launch the
server as described below; client-specific integrations have not been validated.

## Start locally

```sh
npm ci
npm run build
npm start --silent
```

The server waits for MCP messages on stdin and writes protocol responses to
stdout. It does not print a startup banner or open an HTTP port. Diagnostics go
to stderr. Stop a manual session with Ctrl+C.

For an MCP client that supports local stdio servers, use `node` as the command
and the absolute path to `dist/index.js` as its argument. For example, clients
using an `mcpServers` configuration can use:

```json
{
  "mcpServers": {
    "wp-migrate-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/wp-migrate-mcp/dist/index.js"]
    }
  }
}
```

Replace the example path with your checkout path. The client must be able to find
a supported Node.js version. Launching Node directly keeps npm's script banners
out of the protocol stream. Rebuild after changing TypeScript source files.

The server identifies itself as `wp-migrate-mcp`, using the version from
`package.json`. List tools and call `ping` with `{}` to receive
`structuredContent: { "status": "ok" }` plus the same JSON in a text content block
for compatibility. This internal check does not access WordPress or run commands.

## Development

Requirements: Node.js 22.13+ (22.x) or 24+ and npm. WordPress and WP-CLI are not needed
to run the server or its tests.

```sh
npm ci
npm run build
npm test
npm run lint
npm run typecheck
npm run format:check
```

| Script                 | Purpose                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `npm start --silent`   | Start the compiled MCP server over stdio                             |
| `npm run build`        | Compile `src/` to `dist/` with source maps                           |
| `npm run typecheck`    | Check source, tests, and Vitest configuration without emitting files |
| `npm test`             | Run tests once                                                       |
| `npm run test:watch`   | Run tests in watch mode                                              |
| `npm run lint`         | Lint JavaScript and TypeScript; fail on warnings                     |
| `npm run format`       | Format project files with Prettier                                   |
| `npm run format:check` | Check formatting without modifying files                             |

The project uses native ES modules and strict TypeScript. Tests and tooling
configuration are excluded from the build. The package is marked private while
the initial implementation is under development.

## Structure

```text
src/
  index.ts       Small application entry point
  mcp/           MCP server factory, ping tool, and stdio setup
  wordpress/     Reserved for WordPress services and the WP-CLI adapter
  migration/     Reserved for migration analysis and planning
  utils/         Reserved for shared utilities as needed
tests/           Vitest tests
```

The reserved directories contain only `.gitkeep` files so Git retains them.
No migration functionality has been implemented.

## License

[MIT](LICENSE).
