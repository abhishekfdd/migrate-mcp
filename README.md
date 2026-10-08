# wp-migrate-mcp

An open-source Model Context Protocol (MCP) server being built to help AI coding
agents analyze, plan, and validate complex WordPress migrations.

**Status: early development.** The server runs over stdio and exposes
`migration_site_info`, `migration_database_info`, `migration_list_content_types`,
`migration_list_taxonomies`, `migration_list_custom_tables`,
`migration_analyze_users`, and `migration_analyze_media`, which read metadata
through the existing services and WP-CLI adapter. The temporary `ping` tool has
been removed.
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
Single-site role summaries include every user. The `migration_analyze_users` tool
exposes these results.

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

The internal `MediaAnalyzer.analyze()` returns attachment summaries for the active
site only, including all stored attachment statuses, deterministic MIME/category
counts, ID bounds, missing metadata, missing parents, and upload configuration.
The `migration_analyze_media` tool exposes the default summary.
`unattachedAttachments` means
`post_parent = 0` and is not a broken-media warning; `orphanedAttachments` means a
nonzero parent ID has no existing post. Missing metadata means absent/empty data,
not invalid serialized data. Some formats legitimately lack attachment metadata.
The lowest meta ID supplies the primary attached-file value if duplicates exist.

Uploads come from `wp_upload_dir(null, false)`, which disables directory creation,
and the year/month option. Plugins/themes load so upload-directory filters apply;
the trusted-bootstrap limitations above remain. `siteId` and `multisite` identify
the current WP-CLI site; network sites are never scanned automatically. Custom
upload directories, URLs, and multisite paths are taken from this runtime rather
than inferred from `wp-content/uploads`.

Physical checks are opt-in: `analyze({ checkLocalFiles: true })`. They use keyset
pages of at most 100 attachments, bounded by the initial maximum ID, and inspect
filesystem metadata only. References exceeding 1,024 bytes are withheld and
reported as unsafe. Relative references resolve under the configured upload base;
legacy absolute references are accepted only inside that base. Traversal, stream
wrappers, and symlinks below the trusted base are rejected. The base itself may
resolve through a configured symlink. No file contents are read, no files are
hashed, and no directories are recursively scanned. These checks assume a stable,
trusted filesystem; they are not a sandbox against concurrent symlink changes.

`checkedLocalFiles` counts definitive present/missing results; `missingLocalFiles`
counts confirmed absences within that subset. Permissions, unavailable upload
storage, oversized paths, and unsafe references produce warnings rather than
false missing-file counts. A wholly inconclusive check omits `missingLocalFiles`.
Without opt-in, both file counts are omitted with `LOCAL_FILES_NOT_CHECKED`.
Generated sizes, thumbnails, original-image metadata, and dangling postmeta are
not inspected. `externalMediaCount` counts explicit HTTP(S), FTP, S3, GS, or
protocol-relative URI indicators in the primary attached-file value. It does not
verify remote availability or detect every offload plugin/CDN; a missing local
file alone is not offload evidence. No remote requests are made.

Summary SQL uses aggregates without loading attachment records into Node.
Exact counts still require database scans. Optional file checks take one WP-CLI
bootstrap per page plus filesystem operations per path component, so they can be
expensive on large sites or slow storage. Memory remains bounded by the page size.
The process timeout/output limit applies to each command, not the whole analysis.
Media inspection requires 64-bit PHP. Reads are not a transactional snapshot;
concurrent edits may cause validation
failures or a changed-count warning. Same-count edits may be undetectable.

The internal `UrlReferenceAnalyzer.analyze()` returns URL/reference summaries;
no URL MCP tool is registered yet. It scans the active site's `posts.post_content`,
`posts.post_excerpt`, `postmeta.meta_value`, `options.option_value`,
`termmeta.meta_value`, `comments.comment_content`, and `commentmeta.meta_value`
through fixed WP-CLI PHP and read-only SQL. Table names come from `$wpdb`, including
multisite prefixes. It does not scan other network sites, usermeta, GUIDs, comment
author identities, network options, or custom tables.

`totalReferences` counts HTTP(S) and protocol-relative URL occurrences, including
repeated URLs, not matching rows or unique URLs. Hosts are lowercased, stripped of
trailing dots, and grouped independently of ports and protocols. HTTP, HTTPS, and
protocol-relative counts are separate. `sourceUrlReferences` matches configured
site/home hostnames exactly; everything else is external, without implying a
problem. `siteUrlReferences`, `homeUrlReferences`, and `uploadUrlReferences` match
host, normalized port, and a path boundary, ignoring scheme; these counts may
overlap. Observed `www` variants are reported as `alternateSourceHosts` hints,
not verified ownership. Host maps, location summaries, and warnings are sorted.

Serialized-looking values are detected with `is_serialized()` and scanned as
text, never unserialized or rewritten. Valid JSON is decoded to arrays/scalars
with a depth limit of 32; string values are scanned once, including escaped URLs.
Malformed JSON falls back to text scanning. Serialized/JSON counters count URL
occurrences within those values. Development indicators include loopback URLs,
`.local`, `.test`, `.localhost`, and delimited dev/staging hostname labels.
External media hints use the configured upload URL, a small CDN hostname list,
`cdn` labels, and common media extensions. Filesystem hints recognize common
absolute Unix roots and Windows drive paths, excluding paths inside URL tokens.
Only counts are returned; files, hosts, and remote media are never accessed.

Raw rows stay inside PHP. Secret-bearing option/meta keys and transient entries
are excluded in SQL; sensitive JSON fields are skipped. No post content, option
values, discovered full URLs, or filesystem paths are returned. Configured URLs
omit userinfo, query strings, and fragments. Key-name filtering is conservative
and may exclude useful data; it is not an exhaustive classification of secrets.
Returned hostnames and configured URL paths remain intentional inventory data.

Each fixed location uses 100-value primary-key pages bounded by its initial
maximum ID. Values over 64 KiB, NUL-containing values, and invalid UTF-8 are skipped
with counters/warnings. Host maps retain at most 1,000 encountered hosts; omitted
host occurrences remain in totals and `unreportedHostReferences`. Memory is
bounded; one WordPress bootstrap handles the scan, but reading large core tables
can still be expensive and the existing process timeout/output limit applies.
Reads are not a consistent snapshot. Only ASCII/punycode DNS names and IP literals
are recognized; bare hostnames, encoded/compressed content, deeply nested JSON,
and uncommon filesystem paths may be missed. Counts are observations within this
scope, not a replacement plan or a complete reference audit. Plugins/themes load
for effective upload configuration, with directory creation disabled; existing
trusted-bootstrap limitations apply. A 64-bit PHP runtime is required.

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

## Call the user analysis tool

Use the same server configuration and WordPress prerequisites. To analyze user
statistics, role distribution, multisite memberships, duplicate-account
indicators, and usermeta risks, send this `params` object in a `tools/call` request:

```json
{
  "name": "migration_analyze_users",
  "arguments": { "path": "/absolute/path/to/wordpress" }
}
```

Input uses the same strict, absolute-path validation as the other tools. The
analysis is returned directly in `structuredContent` plus matching JSON text,
preserving numeric counts/IDs, role ordering, structured memberships, and warnings.
It includes `roleSiteId`, `siteUserCount`, and `administratorCount` from the domain
model; role summaries apply to the active site while totals cover the shared
users table. Optional fields remain absent when unavailable. User records, auth
secrets, raw capabilities, and duplicate email/login values are excluded.
Existing analyzer limitations above apply. Errors use `isError: true` with
sanitized guidance; malformed analyzer output returns `INVALID_ANALYZER_RESPONSE`.

## Call the media analysis tool

Use the same server configuration and WordPress prerequisites. To report attachment
counts, MIME distribution, missing metadata, unattached/orphaned attachments,
upload configuration, external-reference indicators, and migration risks, send
this `params` object in a `tools/call` request:

```json
{
  "name": "migration_analyze_media",
  "arguments": { "path": "/absolute/path/to/wordpress" }
}
```

Input uses the same strict, absolute-path validation as the other tools; only
`path` is accepted. The domain analysis is returned directly in `structuredContent`
plus matching JSON text, preserving numeric counts/IDs, MIME/category objects,
booleans, optional fields, and ordered warnings. `siteId` and `multisite` identify
the active site. Upload paths are limited to the configuration returned by the
analyzer; individual attachment paths and file contents are not returned.

This tool calls the analyzer's default summary mode. Physical file checks are
not enabled: `missingLocalFiles` and `checkedLocalFiles` are omitted, with a
`LOCAL_FILES_NOT_CHECKED` warning. It does not accept a `checkLocalFiles` option.
Other analyzer limitations above apply. Failures use `isError: true` and sanitized
guidance; malformed analyzer output returns `INVALID_ANALYZER_RESPONSE`.

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

URL inspection also has PHP runtime tests with mocked WordPress functions and
database responses. They run when `php` is on PATH and are skipped otherwise;
the adapter and domain tests always run. No WordPress installation, database,
or internet access is needed. Install PHP locally to exercise the extraction
code itself as well as its TypeScript boundaries.

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
