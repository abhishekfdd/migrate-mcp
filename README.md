# wp-migrate-mcp

An open-source Model Context Protocol (MCP) server being built to help AI coding
agents analyze, plan, and validate complex WordPress migrations.

**Status: early development.** This repository currently contains only the
TypeScript project scaffold and development tooling. It does not yet run an MCP
server, invoke WP-CLI, or provide migration tools.

## Scope

The initial implementation will be strictly **read-only**: it must not modify
WordPress databases, files, users, posts, media, or configuration. Migration
execution is outside the initial scope.

The planned architecture separates MCP protocol handling from domain services
and puts WP-CLI behind an adapter using safe process execution without arbitrary
shell commands. Services will return structured, JSON-friendly results and have
focused tests. The official MCP TypeScript SDK and WP-CLI integration will be
added in later steps.

The project aims to support MCP clients such as ChatGPT, Codex, Claude Code, and
VS Code-compatible clients. Client integration is not available yet.

## Development

Requirements: Node.js 22.13+ (22.x) or 24+ and npm. WordPress and WP-CLI are not needed
for the scaffold.

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
| `npm run build`        | Compile `src/` to `dist/` with source maps                           |
| `npm run typecheck`    | Check source, tests, and Vitest configuration without emitting files |
| `npm test`             | Run tests once                                                       |
| `npm run test:watch`   | Run tests in watch mode                                              |
| `npm run lint`         | Lint JavaScript and TypeScript; fail on warnings                     |
| `npm run format`       | Format project files with Prettier                                   |
| `npm run format:check` | Check formatting without modifying files                             |

The project uses native ES modules and strict TypeScript. Tests and tooling
configuration are excluded from the build. The package is marked private while
the initial scaffold is under development.

## Structure

```text
src/
  index.ts       Inert entry point for future MCP integration
  mcp/           Reserved for MCP protocol handling
  wordpress/     Reserved for WordPress services and the WP-CLI adapter
  migration/     Reserved for migration analysis and planning
  utils/         Reserved for shared utilities as needed
tests/           Vitest tests
```

The reserved directories contain only `.gitkeep` files so Git retains them.
No migration functionality has been implemented.

## License

[MIT](LICENSE).
