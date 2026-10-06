import { z } from 'zod';

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
const tableNames = z
  .array(z.string().min(1))
  .refine(
    (names) => new Set(names).size === names.length,
    'Table names must be unique',
  );

export const databaseMetadataSchema = z.object({
  databaseName: z.string().min(1),
  databaseHost: z.string().min(1),
  tables: tableNames,
  coreTables: tableNames,
  sizeBytes: optionalInteger,
  charset: optionalText,
  collation: optionalText,
  siteCount: optionalInteger,
});

export type WpDatabaseMetadata = z.infer<typeof databaseMetadataSchema>;

// Fixed PHP and read-only SQL executed by WP-CLI using WordPress's connection.
// No caller input is interpolated, and only DB_NAME/DB_HOST are read from config.
export const databaseMetadataPhp = `global $wpdb;
$previous_errors = $wpdb->suppress_errors(true);
try {
    $rows = $wpdb->get_results('SHOW FULL TABLES', ARRAY_N);
    if ($wpdb->last_error || !is_array($rows)) {
        WP_CLI::error('Unable to list database tables.');
    }
    $tables = array();
    foreach ($rows as $row) {
        if ($row[1] === 'BASE TABLE') {
            $tables[] = $row[0];
        }
    }

    $blog_ids = array(get_current_blog_id());
    $site_count = null;
    if (is_multisite()) {
        $blog_ids = get_sites(array('fields' => 'ids', 'number' => 0));
        if ($wpdb->last_error || !is_array($blog_ids) || !$blog_ids) {
            WP_CLI::error('Unable to enumerate multisite blogs for core table classification.');
        }
        $site_count = count($blog_ids);
    }
    // Core class defaults exclude tables registered by third-party code.
    $defaults = get_class_vars('wpdb');
    $core_keys = array_fill_keys(array_merge(
        $defaults['tables'], $defaults['global_tables'], $defaults['ms_global_tables']
    ), true);
    $core_tables = array();
    foreach ($blog_ids as $blog_id) {
        $core_tables = array_merge($core_tables, array_values(array_intersect_key(
            $wpdb->tables('all', true, $blog_id), $core_keys
        )));
    }

    // Optional metadata: permission failures and incomplete size data yield null.
    $stats = $wpdb->get_row("SELECT COUNT(*) AS table_count,
        COUNT(DATA_LENGTH + INDEX_LENGTH) AS measured_count,
        SUM(DATA_LENGTH + INDEX_LENGTH) AS size_bytes
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'", ARRAY_A);
    $size = null;
    if (!$wpdb->last_error && is_array($stats)
        && (int) $stats['table_count'] === count($tables)
        && (int) $stats['measured_count'] === count($tables)) {
        $size = count($tables) === 0 ? '0' : $stats['size_bytes'];
    }
    $schema = $wpdb->get_row("SELECT DEFAULT_CHARACTER_SET_NAME AS charset,
        DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA
        WHERE SCHEMA_NAME = DATABASE()", ARRAY_A);
    if ($wpdb->last_error || !is_array($schema)) {
        $schema = array();
    }
    echo wp_json_encode(array(
        'databaseName' => DB_NAME,
        'databaseHost' => DB_HOST,
        'tables' => $tables,
        'coreTables' => array_values(array_unique($core_tables)),
        'sizeBytes' => $size,
        'charset' => isset($schema['charset']) ? $schema['charset'] : null,
        'collation' => isset($schema['collation']) ? $schema['collation'] : null,
        'siteCount' => $site_count
    ));
} finally {
    $wpdb->suppress_errors($previous_errors);
}`;
