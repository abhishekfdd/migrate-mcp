# wp-migrate-mcp

An open-source Model Context Protocol (MCP) server being built to help AI coding
agents analyze, plan, and validate complex WordPress migrations.

**Status: early development.** The server runs over stdio and exposes
`migration_site_info`, `migration_database_info`, `migration_list_content_types`,
`migration_list_taxonomies`, and `migration_list_custom_tables`, which read
metadata through the existing services and WP-CLI adapter. The temporary `ping`
tool has been removed.
Migration execution is not implemented.

## Scope

The initial implementation will be strictly **read-only**: it must not modify
WordPress databases, files, users, posts, media, or configuration. Migration
execution is outside the initial scope.

The planned architecture separates MCP protocol handling from domain services
and puts WP-CLI behind an adapter using safe process execution without arbitrary
shell commands. Services will return structured, JSON-friendly results and have
focused tests. MCP infrastructure uses the official
[TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) v2 server
package. The internal `WpCliClient` uses the process runner with fixed metadata
commands, a WordPress path, and an optional trusted WP binary path (default `wp`).
Its tests inject a mock runner and do not require WordPress or WP-CLI.

`SiteInfoService.getSiteInfo()` returns the WordPress version, multisite status,
site URL, home URL, active site's table prefix, PHP version used by WP-CLI, and
WP-CLI version. The PHP version may differ from the web server's runtime. On
multisite, the prefix is for the site selected by WP-CLI and may include a blog
ID. URLs retain WordPress's effective option values without normalization.

The adapter reads runtime metadata using fixed internal PHP through `wp eval`;
it accepts no caller-supplied PHP or SQL. These reads bootstrap WordPress with
plugins, themes, and CLI packages skipped for site and database metadata. Trusted
installation code, including must-use plugins and drop-ins, can still run during
bootstrap; this is not an
isolation boundary for untrusted WordPress code. No mutation commands or direct
MySQL access are implemented.

The internal `ContentTypeAnalyzer.analyze()` inspects all registered post types,
including internal types, through fixed WP-CLI runtime PHP. This inspection loads
plugins and the active theme so their custom registrations are visible; CLI
packages remain skipped. The `migration_list_content_types` tool exposes the
results, sorted by name, with sorted support names and numeric counts of all
stored rows for each registered type, across all statuses (including drafts,
trash, and auto-drafts), for the active site only. Unregistered types with
leftover rows are not included.

Metadata reflects the WP-CLI runtime context: registrations conditional on web,
admin, or REST requests may differ, and WP-CLI configuration may skip extensions.
Loading trusted extension code can have its own bootstrap side effects. REST base
and rewrite slug are reported when present on the runtime object; an implicit
REST base is not inferred. `hasArchive` preserves a custom archive slug string.
WordPress may normalize capability types to a singular string, so the original
plural registration cannot always be recovered. Labels follow the runtime locale.

The internal `TaxonomyAnalyzer.analyze()` uses the same runtime inspection
approach, including loading plugins and the active theme. It returns all
registered taxonomies (including internal ones), their runtime built-in status,
metadata, sorted object types, and numeric term counts, sorted by taxonomy name.
Counts cover stored rows in the active site's term taxonomy table, including
unused terms; they do not count post assignments or validate referential
integrity. Unregistered taxonomies with leftover rows are not included. Optional
labels, descriptions, REST bases, and rewrite slugs are reported when available;
implicit REST bases are not inferred. The runtime and bootstrap limitations
above also apply. The `migration_list_taxonomies` tool exposes these results.

The internal `CustomTableAnalyzer.analyze()` lists visible base tables that are
not in the installed WordPress core table mapping. It shares core discovery with
database information: core class defaults are mapped through `$wpdb` for each
registered blog, including network tables and custom user-table overrides.
Views are excluded. Legacy tables, deleted-blog tables, and tables belonging to
other installations may appear in the custom list; custom does not prove plugin
ownership. The `migration_list_custom_tables` tool exposes these results.

Table statistics and common reference-column names come from `information_schema`,
without reading table contents or performing exact row counts. Row counts and
data/index sizes are metadata estimates; unavailable statistics are omitted.
Owner names and `referenceHints` are naming hints, not verified ownership or
foreign keys. Results are sorted by full table name. `usesWordPressPrefix` tests
the active site's prefix; `logicalName` removes a matching registered site prefix
or the network base prefix. Known numbered subsite prefixes yield `siteId` and
`siteSpecific: true`. Base-prefixed multisite custom tables have ambiguous
`network-or-main-site` scope; unknown numeric prefixes remain `unknown`.
An empty prefix matches every name but does not establish site scope. Metadata
work scales with table/site counts, not data volume; the existing process timeout
and 1 MiB output limit still apply to very large inventories. The database
inspection bootstrap limitations above also apply.

The internal `UserAnalyzer.analyze()` returns summary-only user information. Total
users and minimum/maximum IDs cover the shared users table once, even on multisite;
`maxUserId` is the highest currently assigned ID, not an auto-increment forecast.
`roleSiteId` identifies the active site for role counts, administrator count, and
users without a recognized role. Role counts can overlap for users with multiple
roles. On multisite, `siteUserCount` and per-site memberships count distinct
existing users with stored site capability keys, including empty/malformed values;
they are membership evidence, not effective access checks or super-admin counts.
Network users with no active-site membership are excluded from its role summary.
Single-site role summaries include every user. No user MCP tool is registered yet.

Duplicate email/login counts report extra accounts beyond the first in each
equal-value group, including blank values, using database collation semantics.
Actual emails, logins, passwords, activation keys, and auth-related meta values
are never returned. Aggregate queries count duplicates, memberships, orphaned
usermeta rows, and existing users with more than 1,000 meta rows. Capability-key
checks cover this installation's base prefix; unknown site prefixes, unexpected
keys, and duplicate rows become warnings. Active-site role parsing uses the
lowest capability meta ID per user in batches of 500, with object deserialization
disabled and a 64 KiB/16-level decoding limit. Malformed or non-boolean values
produce summary warnings. Role names come from the runtime registry; registered
role keys count as roles even when their stored value is false, matching WordPress.

User analysis skips plugins/themes and uses persisted role definitions; dynamic
plugin roles or authorization filters may differ. Only active-site capability
values are decoded. Exact aggregates still require index/group scans and may be
costly on large installations; queries are not a transactional snapshot. The
existing process timeout/output limit and trusted-bootstrap limitations apply.
Unavailable optional usermeta risk counts produce a warning rather than zero.
No user records or arbitrary usermeta values are loaded into the Node process.

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
`package.json`. To call `migration_site_info`, the server host needs PHP, `wp` on
its process `PATH`, and access to a trusted WordPress installation and its
database. The configured server command above is unchanged; the WordPress path
is provided as a tool argument, not as the server's working directory.

## Call the site information tool

After the MCP client connects, invoke `migration_site_info` with:

```json
{
  "path": "/absolute/path/to/wordpress"
}
```

The path must be absolute on the server host. Empty paths, NUL bytes, and extra
input properties are rejected. A `tools/call` request looks like:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "migration_site_info",
    "arguments": {
      "path": "/absolute/path/to/wordpress"
    }
  }
}
```

Successful results include a `structuredContent` object such as:

```json
{
  "wordpressVersion": "6.8.3",
  "isMultisite": false,
  "siteUrl": "https://example.com/wordpress",
  "homeUrl": "https://example.com",
  "tablePrefix": "wp_",
  "phpVersion": "8.3.0",
  "wpCliVersion": "2.12.0"
}
```

The same JSON is returned in a text content block for compatibility. Known
execution failures return `isError: true` with an error code and guidance, such
as `EXECUTABLE_NOT_FOUND` or `TIMEOUT`. Raw subprocess output and exception
details are not included in tool errors.

## Call the database information tool

Use the same server configuration and WordPress prerequisites. After connecting,
call `migration_database_info` with the same strict, absolute-path input:

```json
{
  "name": "migration_database_info",
  "arguments": { "path": "/absolute/path/to/wordpress" }
}
```

This is the `params` object for a `tools/call` request. The result contains
`structuredContent` plus the same JSON in a text block: database name and host,
table prefix, numeric total/core/custom table counts, and multisite status.
Size in bytes, database-default charset/collation, and multisite `siteCount` are
included when available. Credentials and connection secrets are excluded.
Counts cover visible base tables across the database; size is a metadata estimate.
Errors follow the site information tool's `isError: true` convention.

## Call the content type information tool

Use the same server configuration and WordPress prerequisites. To list all
registered content types, including built-in, internal, and custom types, send
this `params` object in a `tools/call` request:

```json
{
  "name": "migration_list_content_types",
  "arguments": { "path": "/absolute/path/to/wordpress" }
}
```

Input uses the same strict, absolute-path validation as the other tools. Results
contain `structuredContent: { "contentTypes": [...] }` plus matching JSON in a
text block. Each entry includes metadata such as capability type, REST
configuration, supports, and numeric post counts, with optional values included
when available. The analyzer's deterministic ordering is preserved. Counts cover
all statuses for the active site; this inspection loads plugins and the active
theme as described above. Errors use the same `isError: true` convention.

## Call the taxonomy information tool

Use the same server configuration and WordPress prerequisites. To list all
registered taxonomies, including built-in, internal, and custom taxonomies,
send this `params` object in a `tools/call` request:

```json
{
  "name": "migration_list_taxonomies",
  "arguments": { "path": "/absolute/path/to/wordpress" }
}
```

Input uses the same strict, absolute-path validation as the other tools. Results
contain `structuredContent: { "taxonomies": [...] }` plus matching JSON in a text
block. Entries preserve the analyzer's metadata: associated object types, REST
configuration, rewrite settings, built-in/custom status, and numeric term counts.
Optional metadata is included when available. Taxonomies and their object types
retain the analyzer's deterministic ordering. Counts include unused terms for
the active site. Runtime and bootstrap limitations described above apply, and
errors use the same `isError: true` convention.

## Call the custom table information tool

Use the same server configuration and WordPress prerequisites. To list non-core
database tables with estimated rows and sizes, multisite scope, and likely plugin
ownership where it can be inferred, send this `params` object in a `tools/call`
request:

```json
{
  "name": "migration_list_custom_tables",
  "arguments": { "path": "/absolute/path/to/wordpress" }
}
```

Input uses the same strict, absolute-path validation as the other tools. Results
contain `structuredContent: { "customTables": [...] }` plus matching JSON in a
text block, preserving the analyzer's ordering, numeric estimates, optional
metadata, `scope`, and `referenceHints`. Ownership and reference hints are not
verified relationships; base-prefixed multisite tables can retain ambiguous
`network-or-main-site` scope. The tool adds no filtering and exposes no SQL,
commands, or credentials. Existing analyzer limitations above apply; errors use
the same `isError: true` convention.

## Development

Requirements: Node.js 22.13+ (22.x) or 24+ and npm. WordPress and WP-CLI are not needed
to start the server, discover tools, or run its mocked tests. Calling the site
information tool requires the installation described above.

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
  mcp/           MCP server factory, site information tool, and stdio setup
  wordpress/     WP-CLI adapter and site information service
  migration/     Content type, taxonomy, custom table, and user analyzers
  utils/         Safe process execution utility
tests/           Vitest tests
```

Migration execution has not been implemented.

## License

[MIT](LICENSE).
