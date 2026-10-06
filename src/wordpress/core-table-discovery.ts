// Shared application-controlled PHP for database inspection. Uses the installed
// core class defaults and runtime table mapping, including custom user tables.
export const coreTableDiscoveryPhp = `$blog_ids = array(get_current_blog_id());
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
}`;
