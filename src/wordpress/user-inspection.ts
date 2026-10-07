import { largeMetaSetThreshold } from './user-metadata.js';

// Only fixed queries and runtime identifiers. Raw accounts and capability values
// stay inside this process; no usermeta values except capabilities are selected.
export const userMetadataPhp = `global $wpdb;
$previous_errors = $wpdb->suppress_errors(true);
try {
    $users = chr(96) . str_replace(chr(96), chr(96) . chr(96), $wpdb->users) . chr(96);
    $meta = chr(96) . str_replace(chr(96), chr(96) . chr(96), $wpdb->usermeta) . chr(96);
    $read_rows = static function ($sql) use ($wpdb) {
        $rows = $wpdb->get_results($sql, ARRAY_A);
        if ($wpdb->last_error || !is_array($rows)) {
            WP_CLI::error('Unable to read required user analysis data. Check database access and compatibility.');
        }
        return $rows;
    };
    $totals = $read_rows("SELECT COUNT(*) AS totalUsers, MIN(ID) AS minUserId, MAX(ID) AS maxUserId FROM $users");
    $result = $totals[0];
    if ((float) $result['maxUserId'] > 9007199254740991) {
        WP_CLI::error('User IDs exceed the safely supported numeric range.');
    }
    foreach (array('user_email' => 'duplicateEmailCount', 'user_login' => 'duplicateLoginCount') as $column => $field) {
        $duplicates = $read_rows("SELECT COALESCE(SUM(n - 1), 0) AS duplicate_count
            FROM (SELECT COUNT(*) AS n FROM $users GROUP BY $column HAVING COUNT(*) > 1) AS duplicates");
        $result[$field] = $duplicates[0]['duplicate_count'];
    }
    $multisite = is_multisite();
    $active_site = get_current_blog_id();
    $blog_ids = array($active_site);
    if ($multisite) {
        $blog_ids = get_sites(array('fields' => 'ids', 'number' => 0));
        if ($wpdb->last_error || !is_array($blog_ids) || !$blog_ids) {
            WP_CLI::error('Unable to enumerate sites for user membership analysis.');
        }
    }
    $memberships = array();
    $known_keys = array();
    foreach ($blog_ids as $id) {
        $known_keys[$wpdb->get_blog_prefix($id) . 'capabilities'] = $id;
        $memberships[$id] = 0;
    }
    if (!isset($memberships[$active_site])) {
        WP_CLI::error('The active site is absent from the registered site list.');
    }
    $cap_key = $wpdb->get_blog_prefix($active_site) . 'capabilities';
    $result['unknownSiteCapabilityRows'] = 0;
    $result['unexpectedCapabilityRows'] = 0;
    $result['duplicateCapabilityRows'] = 0;
    $cap_summary = $read_rows($wpdb->prepare("SELECT m.meta_key AS capability_key,
        COUNT(*) AS row_count, COUNT(DISTINCT m.user_id) AS user_count
        FROM $meta m INNER JOIN $users u ON u.ID = m.user_id
        WHERE m.meta_key LIKE %s GROUP BY m.meta_key",
        $wpdb->esc_like($wpdb->base_prefix) . '%' . $wpdb->esc_like('capabilities')));
    foreach ($cap_summary as $row) {
        $key = $row['capability_key'];
        if (isset($known_keys[$key])) {
            $memberships[$known_keys[$key]] = (int) $row['user_count'];
            $result['duplicateCapabilityRows'] += (int) $row['row_count'] - (int) $row['user_count'];
        } elseif (preg_match('/^' . preg_quote($wpdb->base_prefix, '/') . '[0-9]+_capabilities$/D', $key)) {
            $result['unknownSiteCapabilityRows'] += (int) $row['row_count'];
        } else {
            $result['unexpectedCapabilityRows'] += (int) $row['row_count'];
        }
    }
    $result['multisite'] = (bool) $multisite;
    $result['roleSiteId'] = $active_site;
    $result['siteUserCount'] = $multisite ? $memberships[$active_site] : (int) $result['totalUsers'];
    if ($multisite) {
        $result['siteMemberships'] = array();
        foreach ($memberships as $id => $user_count) {
            $result['siteMemberships'][] = array('siteId' => $id, 'userCount' => $user_count);
        }
    }

    $role_counts = array_fill_keys(array_keys(wp_roles()->get_names()), 0);
    $users_with_role = 0;
    $result['malformedCapabilityUsers'] = 0;
    $result['nonBooleanCapabilityUsers'] = 0;
    $last_user = -1;
    do {
        // One deterministic capability row per existing user; bounded keyset pages.
        $page = $read_rows($wpdb->prepare("SELECT first_caps.user_id,
            CASE WHEN OCTET_LENGTH(m.meta_value) <= 65536 THEN m.meta_value ELSE NULL END AS capabilities
            FROM (SELECT c.user_id, MIN(c.umeta_id) AS first_id
                FROM $meta c INNER JOIN $users u ON u.ID = c.user_id
                WHERE c.meta_key = %s AND c.user_id > %d
                GROUP BY c.user_id ORDER BY c.user_id LIMIT 500) AS first_caps
            INNER JOIN $meta m ON m.umeta_id = first_caps.first_id ORDER BY first_caps.user_id",
            $cap_key, $last_user));
        foreach ($page as $row) {
            $last_user = $row['user_id'];
            // Disable object instantiation when examining serialized database values.
            $caps = is_string($row['capabilities']) && is_serialized($row['capabilities'])
                ? @unserialize(trim($row['capabilities']), array('allowed_classes' => false, 'max_depth' => 16)) : false;
            if (!is_array($caps)) {
                $result['malformedCapabilityUsers']++;
                continue;
            }
            $has_role = false;
            $non_boolean = false;
            foreach ($caps as $key => $value) {
                // WordPress identifies roles by registered keys, even for false values.
                if (array_key_exists($key, $role_counts)) {
                    $role_counts[$key]++;
                    $has_role = true;
                }
                if (!is_bool($value)) { $non_boolean = true; }
            }
            if ($has_role) { $users_with_role++; }
            if ($non_boolean) { $result['nonBooleanCapabilityUsers']++; }
        }
    } while (count($page) === 500);
    $result['roleCounts'] = (object) $role_counts;
    $result['usersWithoutRole'] = $result['siteUserCount'] - $users_with_role;

    // Optional index aggregation: counts rows only, never reads arbitrary meta values.
    $risk = $wpdb->get_results("SELECT
        COALESCE(SUM(CASE WHEN u.ID IS NULL THEN counts.meta_count ELSE 0 END), 0) AS orphanedUsermetaRows,
        COALESCE(SUM(CASE WHEN u.ID IS NOT NULL AND counts.meta_count > ${largeMetaSetThreshold} THEN 1 ELSE 0 END), 0) AS usersWithLargeMetaSets
        FROM (SELECT user_id, COUNT(*) AS meta_count FROM $meta GROUP BY user_id) AS counts
        LEFT JOIN $users u ON u.ID = counts.user_id", ARRAY_A);
    if (!$wpdb->last_error && is_array($risk) && count($risk) === 1) {
        $result['orphanedUsermetaRows'] = $risk[0]['orphanedUsermetaRows'];
        $result['usersWithLargeMetaSets'] = $risk[0]['usersWithLargeMetaSets'];
    }
    echo wp_json_encode($result);
} finally {
    $wpdb->suppress_errors($previous_errors);
}`;
