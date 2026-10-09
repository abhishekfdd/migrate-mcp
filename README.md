# Migrate MCP

A read-only MCP server for analyzing, comparing, and planning WordPress migrations.

Migrate MCP gives AI coding agents structured migration-analysis tools through the
Model Context Protocol (MCP). It helps you inspect installations, identify risks,
compare source and target sites, and prepare a migration plan without modifying
either WordPress installation.

**Status:** Early-stage / pre-release. The current release focuses on read-only
migration analysis and planning; tool interfaces and planning models may change.

## Why Migrate MCP?

Traditional migration tools are generally good at moving data. For complex
WordPress migrations, the difficult work often comes before and after that move:

- Understanding what exists on each site.
- Identifying differences between source and target.
- Finding conflicts and migration risks.
- Deciding what needs manual review.
- Defining how to validate the migration.

Migrate MCP focuses on these analysis and planning problems so developers and
agents can make informed decisions before choosing how to execute a migration.

## Key capabilities

- **Site/environment inspection:** WordPress, PHP, and WP-CLI versions, URLs, and multisite status.
- **Database inspection:** Table inventory, prefixes, charset/collation, and estimated size.
- **Content type discovery:** Registered post types, configuration, and stored post counts.
- **Taxonomy discovery:** Registered taxonomies, associated types, and stored term counts.
- **Custom table analysis:** Non-core tables, size estimates, scope, and ownership/reference hints.
- **User migration-risk analysis:** User totals, ID ranges, roles, memberships, and duplicate indicators.
- **Media analysis:** Attachment summaries, metadata/parent anomalies, and upload configuration.
- **URL/environment-reference analysis:** Source-host dependencies, external hosts, and development/path indicators.
- **Source/target comparison:** Configuration differences and categorized migration findings.
- **Migration planning:** Ordered phases, blockers, unresolved decisions, and validation requirements.

## Quick start

### Requirements

- Node.js 22.13+ within 22.x, or Node.js 24+, and npm.
- Git to clone the repository.
- An MCP client that supports local stdio servers.
- To analyze sites: PHP, WP-CLI (`wp`) on the server process's `PATH`, and access
  to trusted WordPress installations and their databases. Media and URL analysis
  require 64-bit PHP.

WordPress and WP-CLI are not needed just to start the server, discover tools, or
run the mocked tests. Client-specific integrations have not been validated.

### Clone, install, and run

Migrate MCP currently runs from a **local checkout**. The package is marked
`"private": true` and is not published for npm installation.

```sh
git clone https://github.com/abhishekfdd/migrate-mcp.git
cd migrate-mcp
npm ci
npm run build
npm start --silent
```

The server waits for MCP messages on stdin and writes protocol responses to
stdout. It does not print a startup banner or open an HTTP port. Diagnostics go
to stderr. Stop a manual session with Ctrl+C.

### Configure an MCP client

For clients using an `mcpServers` configuration, use:

```json
{
  "mcpServers": {
    "migrate-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/migrate-mcp/dist/index.js"]
    }
  }
}
```

Replace the example path with your checkout path. The client launches the server
and must be able to find a supported Node.js version. Launching Node directly
keeps npm's script banners out of the protocol stream. Rebuild after changing
TypeScript source files.

The server identifies itself as `migrate-mcp`, using the version in `package.json`.
WordPress installation paths are tool arguments, not the server's working directory.
After connecting, try `migration_site_info` with:

```json
{
  "path": "/absolute/path/to/wordpress"
}
```

## Example workflow

With both installation paths supplied to your MCP client, a conversation might
look like this. Findings depend on the sites being analyzed.

```text
User:
Compare these two WordPress installations and identify migration risks.

Migrate MCP, through the agent:
- reports content-type and taxonomy differences
- reports custom tables requiring review
- identifies overlapping user ID ranges
- summarizes media metadata and parent anomalies
- reports environment-specific URL references

User:
Generate a migration plan.

Migrate MCP, through the agent:
- produces ordered phases and preparation steps
- reports blockers
- identifies unresolved decisions
- provides post-migration validation requirements
```

The plan is a reviewable artifact; it does not execute the migration or validation.

## Implemented MCP tools

| Tool                           | Purpose                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `migration_site_info`          | Inspect WordPress/runtime versions, URLs, table prefix, and multisite status.  |
| `migration_database_info`      | Summarize database metadata, table counts, and estimated size.                 |
| `migration_list_content_types` | List registered post types, configuration, and post counts.                    |
| `migration_list_taxonomies`    | List registered taxonomies, configuration, and term counts.                    |
| `migration_list_custom_tables` | List non-core tables with metadata estimates and scope/reference hints.        |
| `migration_analyze_users`      | Summarize users, roles, memberships, ID ranges, and usermeta risks.            |
| `migration_analyze_media`      | Summarize attachments, metadata/parent anomalies, and upload configuration.    |
| `migration_analyze_urls`       | Summarize URL dependencies, external hosts, and environment references.        |
| `migration_compare_sites`      | Compare source and target installations and categorize migration risks.        |
| `migration_generate_plan`      | Analyze both sites and produce phases, decisions, and validation requirements. |

### Tool inputs and responses

The first eight tools accept only `path`, an absolute WordPress installation path
on the server host. For example, this is a complete MCP `tools/call` request:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "migration_analyze_urls",
    "arguments": { "path": "/absolute/path/to/wordpress" }
  }
}
```

Comparison and planning accept `sourcePath` and `targetPath`. Use this `params`
object in a `tools/call` request:

```json
{
  "name": "migration_compare_sites",
  "arguments": {
    "sourcePath": "/absolute/path/to/source-wordpress",
    "targetPath": "/absolute/path/to/target-wordpress"
  }
}
```

Use `migration_generate_plan` with the same arguments to run comparison and then
generate a plan. Blank/relative paths, NUL bytes, and additional properties are
rejected. Two paths that normalize to the same absolute path return
`SAME_INSTALLATION`; this lexical check does not detect symlink aliases or
separate directories sharing a database.

Successful calls return `structuredContent` and matching JSON in a text content
block. Content types, taxonomies, and custom tables use `contentTypes`,
`taxonomies`, and `customTables` array wrappers respectively; other tools return
their result object directly. Optional fields remain absent when unavailable.
Known execution failures return `isError: true` with a code and sanitized guidance
(such as `EXECUTABLE_NOT_FOUND` or `TIMEOUT`), without raw subprocess output or
exception details. Comparison/planning failures return no partial result; inspect
both sites individually if the failing side is unclear. Invalid results are
reported as errors, including `INVALID_ANALYZER_RESPONSE`,
`INVALID_COMPARISON_RESPONSE`, or `INVALID_PLAN_RESPONSE`; planner failures use
`PLANNING_FAILED`.

## Safety / read-only model

The current implementation does not:

- Modify database records or files.
- Perform search-replace.
- Migrate content or remap IDs.
- Copy media or create database tables.
- Execute migration plans or validation steps.

WordPress runtime inspection uses fixed internal PHP through WP-CLI where needed.
MCP tools expose neither caller-provided arbitrary PHP nor arbitrary SQL execution.
WP-CLI runs through an adapter using direct process execution without shell parsing;
there are no mutation commands or direct MySQL connections.

Use trusted installations. WordPress bootstrap can execute installation code,
including must-use plugins and drop-ins even when plugins/themes are skipped.
Loading that code can have its own side effects: read-only inspection is not an
isolation boundary for untrusted WordPress code.

User analysis returns summaries, not user records, emails, logins, passwords, or
auth-related meta values. URL analysis excludes secret-bearing option/meta keys,
transients, and sensitive JSON fields, and returns no raw content or discovered
full URLs. This filtering is conservative, not exhaustive secret classification.
Configured URL paths, hostnames, database metadata, and upload configuration are
intentional inventory data; configured URLs in URL analysis omit userinfo, query
strings, and fragments.

## Architecture

```text
src/
├── mcp/         MCP transport, tool registration, validation, and response handling
├── wordpress/   Safe WordPress/WP-CLI integration
├── migration/   Migration analyzers, comparison engine, and planning engine
└── utils/       Shared low-level utilities
```

MCP handlers are thin: they validate inputs and responses and delegate migration
logic to domain services. The server uses the official TypeScript MCP SDK v2 server
package over stdio. The WP-CLI adapter centralizes fixed inspection commands and
process limits; services can be tested with injected adapters and mock runners.

## How analysis works

- **WP-CLI and runtime inspection:** Fixed internal PHP reads effective WordPress
  configuration and registrations. Site/database metadata and user analysis skip
  plugins/themes; content types, taxonomies, media, and URLs load them for runtime
  registrations or upload filters. CLI packages are skipped throughout. Upload
  configuration uses `wp_upload_dir(null, false)` to avoid directory creation.
- **Read-only database queries:** Database/custom-table inspection uses core table
  mappings and `information_schema` metadata. Content, taxonomy, user, and media
  summaries use aggregates; URL analysis scans selected core fields. MCP analysis
  returns summaries without loading raw user, attachment, or URL-content rows
  into the Node process.
- **Bounded analysis:** Active-site user roles are decoded in batches of 500 with
  object deserialization disabled and 64 KiB/16-level limits. URL scans use
  100-value primary-key pages bounded by initial maximum IDs. Internal opt-in
  media file checks use pages of at most 100 attachments.
- **Deterministic output:** Inventories, host summaries, and findings use stable
  ordering. Comparison reuses all eight inspection services once per side, one
  source/target service pair at a time. Unavailable comparison metadata is marked
  `unknown`, rather than treated as zero or a mismatch.
- **Planning:** The MCP planning tool runs comparison, then passes its complete
  result to the pure, synchronous `MigrationPlanner.generatePlan({ comparison })`.
  The planner performs no I/O and produces deterministic phases, dependencies,
  issues, unresolved decisions, manual reviews, and validation requirements.

Plans report `kind: "migration-plan"` and `executionPerformed: false`. They contain
no executable commands, SQL, calculated ID mappings, or completed steps;
`automated` describes potential future automation only. Preflight and validation
are always present; other phases depend on relevant findings/data, and each phase
conservatively depends on all generated earlier phases.

Readiness is `blocked` for blocking findings, `ready_with_warnings` for significant
findings, unresolved decisions, or medium/high-risk manual reviews, and `ready`
otherwise. Informational issues count toward `warningCount` but affect readiness
only when they imply unresolved work. Readiness describes the available evidence,
not execution authorization or a guarantee of safety.

## Limitations

### Runtime and multisite scope

Analysis reflects the WP-CLI runtime. PHP may differ from the web server, and
registrations conditional on web/admin/REST requests or WP-CLI configuration may
not appear. Runtime labels follow the locale; implicit REST bases are not inferred.
User analysis uses persisted roles, so dynamic plugin roles/authorization filters
may differ.

Most analyzers cover only the active site selected by WP-CLI; media and URL scans
do not automatically traverse a multisite network. User totals and ID bounds
cover the shared users table, while roles cover the active site. Memberships are
stored capability-key evidence, not effective access or super-admin checks.
Database inventories cover visible base tables across the database, potentially
including other installations.

### Large sites and consistency

Exact aggregates and URL scans can be expensive even with bounded memory.
Metadata work scales with table/site counts. Each subprocess has a default
30-second timeout and a 1 MiB output limit per stream, not a whole-analysis budget.
Internal file checks add one WP-CLI bootstrap per page and filesystem operations
per path component, which can be costly on slow storage.

Reads and source/target collection are not transactional snapshots. Concurrent
edits can cause inconsistent observations, changed-count warnings, or validation
failures; same-count edits may be undetectable. Use stable installations and
refresh evidence before acting on a plan.

### Counts, registrations, and custom tables

- Post counts include all statuses (including drafts, trash, and auto-drafts) for
  registered types. Taxonomy counts include unused stored terms, not post
  assignments or referential-integrity checks. Unregistered types/taxonomies with
  leftover rows are omitted. Runtime capability normalization can lose the
  original plural capability type; custom archive slugs are preserved.
- User role counts can overlap. Duplicate email/login counts measure extra
  accounts per equal-value group, including blanks, using database collation.
  `maxUserId` is the highest assigned ID, not an auto-increment forecast. Role
  parsing uses the lowest capability meta ID; malformed values and unexpected
  membership keys produce warnings. Unavailable optional risk counts remain
  unknown. Registered role keys count even when their stored value is false,
  matching WordPress. Usermeta summaries include orphaned rows and users with
  over 1,000 meta rows, without returning their values.
- Custom tables are visible base tables absent from the installed core mapping;
  views are excluded. Core discovery accounts for registered blogs, network
  tables, and custom user-table overrides. Legacy/deleted-blog tables and other
  installations can appear as custom. Owner names and `referenceHints` are naming
  hints, not verified plugin ownership or foreign keys.
- Custom-table contents are not scanned, schemas are not compared, and row/size
  statistics are metadata estimates. Prefix-based scope can be ambiguous:
  base-prefixed multisite tables may be `network-or-main-site`, and unknown
  numeric prefixes remain `unknown`. Logical names remove recognized prefixes;
  active-site logical names support matching across source/target prefixes, but
  ambiguous matches are not paired and other blogs are not equated by blog ID.

### Media and filesystem checks

The MCP media tool accepts only `path` and uses summary mode. It does **not** accept
`checkLocalFiles`; `checkedLocalFiles` and `missingLocalFiles` are omitted with
`LOCAL_FILES_NOT_CHECKED`. Comparison and planning inherit this limit.

Attachment summaries cover all stored statuses. `unattachedAttachments` means
`post_parent = 0`, not broken media; `orphanedAttachments` means a nonzero parent
has no existing post. Missing metadata means absent/empty data, not invalid
serialization, and some formats legitimately lack it. The lowest meta ID supplies
the primary attached-file value when duplicates exist. Generated sizes,
thumbnails, original-image metadata, and dangling postmeta are not inspected.
External-reference indicators do not verify remote availability or identify every
offload plugin/CDN; missing local files alone do not prove offloading. No remote
requests are made.

The internal domain API supports `analyze({ checkLocalFiles: true })` for filesystem
metadata checks only. Paths must remain inside the configured upload base;
traversal, stream wrappers, symlinks below that base, and references over 1,024
bytes are rejected. The base itself may be a configured symlink. No file contents,
hashes, or recursive directory scans are used. Permission/storage/path problems
produce warnings instead of false missing-file counts; wholly inconclusive checks
omit `missingLocalFiles`. These checks assume a stable, trusted filesystem and
are not a sandbox against concurrent symlink changes.

### URL/reference analysis

The scan covers the active site's `posts.post_content`, `posts.post_excerpt`,
`postmeta.meta_value`, `options.option_value`, `termmeta.meta_value`,
`comments.comment_content`, and `commentmeta.meta_value`. It excludes usermeta,
GUIDs, comment author identities, network options, custom tables, and other sites.

`totalReferences` counts HTTP(S) and protocol-relative occurrences, including
repeats, not unique URLs or matching rows. Host maps lowercase names, strip
trailing dots, and group independently of ports/protocols. Source-host counts
match site/home hostnames exactly; site/home/upload URL counts also consider
normalized ports and path boundaries, ignoring scheme, and may overlap. External
hosts are not inherently problems; observed `www` variants and CDN/media/path
indicators are hints, not verified ownership or dependencies.

Serialized-looking values are scanned as text, never unserialized or rewritten.
JSON string values are scanned with a depth limit of 32; malformed JSON falls back
to text. Values over 64 KiB, containing NUL bytes, or invalid UTF-8 are skipped with
counters/warnings. Host maps retain at most 1,000 encountered hosts; omitted
occurrences remain in totals and `unreportedHostReferences`.

Only ASCII/punycode DNS names and IP literals are recognized. Bare hostnames,
encoded/compressed content, deeply nested JSON, and uncommon filesystem paths may
be missed. Filtering can exclude useful data. A target host marked `not-observed`
is absent from the bounded scan, not proven absent from the database. Results are
observations within this scope, not a complete reference audit or replacement plan.

### Comparison and planning

Comparison reports differences and risk indicators, not individual account
matches, file comparisons, or migration mappings. Overlapping user ID ranges do
not prove individual collisions; equal versions do not certify compatibility.
Count differences describe volume. Single-site/multisite mismatch is `blocking`
for direct migration; missing source registrations, missing active-site custom
tables, and user ID-range overlap are `high` risks. `info`/`warning` findings appear
in `warnings`, and `high`/`blocking` findings in `conflicts`; `warningCount` includes
informational findings. Any service failure stops the whole comparison.

Plans inherit all analyzer scope and scan limits. They cannot infer schemas,
verified ownership, account matches, or storage permissions, and do not verify
backups. Source-data scope, retained target data, external hosting, and reference
policies remain human decisions. Validation requirements must account for those
decisions and estimated counts; every step requires review and confirmation
before any separately implemented execution workflow.

## Development

```sh
npm ci
npm test
npm run build
npm run lint
npm run typecheck
npm run format:check
```

| Command                | Purpose                                                               |
| ---------------------- | --------------------------------------------------------------------- |
| `npm test`             | Run tests once.                                                       |
| `npm run test:watch`   | Run tests in watch mode.                                              |
| `npm run build`        | Compile `src/` to `dist/` with source maps.                           |
| `npm run lint`         | Lint JavaScript and TypeScript; fail on warnings.                     |
| `npm run typecheck`    | Check source, tests, and Vitest configuration without emitting files. |
| `npm run format`       | Format project files with Prettier.                                   |
| `npm run format:check` | Check formatting without modifying files.                             |

The project uses native ES modules and strict TypeScript. Tests and tooling
configuration are excluded from the build. Adapter/domain tests use mocks and
need no WordPress installation, database, or internet access. URL inspection also
has PHP runtime tests with mocked WordPress functions and database responses;
these run when `php` is on `PATH` and are skipped otherwise. Install PHP to exercise
the extraction code as well as its TypeScript boundaries.

## Contributing

Keep changes focused and run the development checks above before submitting a
pull request. Update documentation when tool inputs, outputs, or limits change.

## License and trademark

[MIT](LICENSE).

WordPress is a registered trademark of the WordPress Foundation.

Migrate MCP is an independent open-source project and is not affiliated with,
endorsed by, or sponsored by the WordPress Foundation or the WordPress project.
