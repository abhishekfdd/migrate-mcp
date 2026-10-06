import { z } from 'zod';
import { coreTableDiscoveryPhp } from './core-table-discovery.js';

const metadataInteger = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const optionalInteger = metadataInteger
  .nullish()
  .transform((value) => value ?? undefined);
const optionalText = z
  .string()
  .nullish()
  .transform((value) => value || undefined);
const prefixSchema = z.string().regex(/^[A-Za-z0-9_]*$/);
const namesSchema = z
  .array(z.string().min(1))
  .refine(
    (names) => new Set(names).size === names.length,
    'Names must be unique',
  );

export const tableMetadataSchema = z.object({
  basePrefix: prefixSchema,
  tablePrefix: prefixSchema,
  multisite: z.boolean(),
  sites: z
    .array(
      z.object({
        id: metadataInteger.pipe(z.number().positive()),
        prefix: prefixSchema,
      }),
    )
    .min(1)
    .refine(
      (sites) =>
        new Set(sites.map((site) => site.id)).size === sites.length &&
        new Set(sites.map((site) => site.prefix)).size === sites.length,
      'Sites must have unique IDs and prefixes',
    ),
  coreTables: namesSchema,
  tables: z
    .array(
      z.object({
        name: z.string().min(1),
        rowCount: optionalInteger,
        sizeBytes: optionalInteger,
        dataSizeBytes: optionalInteger,
        indexSizeBytes: optionalInteger,
        engine: optionalText,
        collation: optionalText,
        referenceColumns: namesSchema.optional(),
      }),
    )
    .refine(
      (tables) =>
        new Set(tables.map((table) => table.name)).size === tables.length,
      'Table names must be unique',
    ),
});

export type WpTableMetadata = z.infer<typeof tableMetadataSchema>;

// Fixed read-only metadata queries through WordPress's connection. No table
// contents, COUNT(*) scans, caller SQL, or credentials are read or returned.
export const tableMetadataPhp = `global $wpdb;
$previous_errors = $wpdb->suppress_errors(true);
try {
    $rows = $wpdb->get_results('SHOW FULL TABLES', ARRAY_N);
    if ($wpdb->last_error || !is_array($rows)) {
        WP_CLI::error('Unable to list database tables.');
    }
    $names = array();
    foreach ($rows as $row) {
        if ($row[1] === 'BASE TABLE') {
            $names[] = $row[0];
        }
    }
    ${coreTableDiscoveryPhp}
    $sites = array();
    foreach ($blog_ids as $blog_id) {
        $sites[] = array('id' => $blog_id, 'prefix' => $wpdb->get_blog_prefix($blog_id));
    }

    // Missing metadata permissions must not prevent listing visible tables.
    $stats = $wpdb->get_results("SELECT TABLE_NAME AS name, TABLE_ROWS AS rowCount,
        DATA_LENGTH + INDEX_LENGTH AS sizeBytes, DATA_LENGTH AS dataSizeBytes,
        INDEX_LENGTH AS indexSizeBytes, ENGINE AS engine, TABLE_COLLATION AS collation
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'", ARRAY_A);
    $stats_by_name = array();
    if (!$wpdb->last_error && is_array($stats)) {
        foreach ($stats as $stat) {
            $stats_by_name[$stat['name']] = $stat;
        }
    }
    $columns = $wpdb->get_results("SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND LOWER(COLUMN_NAME) IN ('post_id', 'user_id', 'term_id', 'comment_id', 'blog_id', 'site_id')", ARRAY_A);
    $columns_available = !$wpdb->last_error && is_array($columns);
    $columns_by_name = array();
    if ($columns_available) {
        foreach ($columns as $column) {
            $columns_by_name[$column['table_name']][] = $column['column_name'];
        }
    }
    $tables = array();
    foreach ($names as $name) {
        $item = isset($stats_by_name[$name]) ? $stats_by_name[$name] : array('name' => $name);
        if ($columns_available) {
            $item['referenceColumns'] = isset($columns_by_name[$name]) ? $columns_by_name[$name] : array();
        }
        $tables[] = $item;
    }
    echo wp_json_encode(array(
        'basePrefix' => $wpdb->base_prefix,
        'tablePrefix' => $wpdb->prefix,
        'multisite' => (bool) is_multisite(),
        'sites' => $sites,
        'coreTables' => array_values(array_unique($core_tables)),
        'tables' => $tables
    ));
} finally {
    $wpdb->suppress_errors($previous_errors);
}`;
