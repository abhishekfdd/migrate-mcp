import { urlReferenceParserPhp } from './url-reference-parser.js';

// No caller SQL/PHP, and only fixed textual core columns. Raw values stay in PHP.
export const urlReferenceMetadataPhp = String.raw`global $wpdb;
if (PHP_INT_SIZE < 8) { WP_CLI::error('URL analysis requires a 64-bit PHP runtime.'); }
$previous_errors = $wpdb->suppress_errors(true);
try {
    $result = array_fill_keys(array('totalReferences', 'sourceUrlReferences', 'externalUrlReferences',
        'httpReferences', 'httpsReferences', 'protocolRelativeReferences', 'siteUrlReferences', 'homeUrlReferences',
        'uploadUrlReferences', 'serializedValueReferences', 'jsonValueReferences', 'filesystemPathReferences',
        'developmentReferenceCount', 'externalMediaReferences', 'malformedUrlReferences', 'unreportedHostReferences',
        'scannedValues', 'skippedSensitiveValues', 'skippedOversizedValues', 'skippedBinaryValues'), 0);
    $result['hostCounts'] = array();
    $result['externalMediaHostCounts'] = array();
    $result['alternateSourceHosts'] = array();
    $result['locations'] = array();
    $result['multisite'] = (bool) is_multisite();
    $result['siteId'] = get_current_blog_id();
    $configured = array(); $source_hosts = array(); $alternate_hosts = array();
    ${urlReferenceParserPhp}
    $uploads = wp_upload_dir(null, false);
    foreach (array('siteUrl' => get_option('siteurl'), 'homeUrl' => get_option('home'),
        'uploadUrl' => empty($uploads['error']) ? ($uploads['baseurl'] ?? null) : null) as $field => $value) {
        $configured[$field] = $parse_reference($value);
        if ($configured[$field] !== null) {
            $result[$field === 'uploadUrl' ? 'uploadBaseUrl' : $field] = $configured[$field]['publicUrl'];
            if ($field !== 'uploadUrl') { $source_hosts[$configured[$field]['host']] = true; }
        }
    }
    foreach ($source_hosts as $host => $_) {
        if (!filter_var($host, FILTER_VALIDATE_IP) && strpos($host, '.') !== false) {
            $alternate_hosts[strpos($host, 'www.') === 0 ? substr($host, 4) : 'www.' . $host] = true;
        }
    }
    $sensitive_pattern = '(pass(word)?|secret|token|salt|api[_-]?key|auth|session|credential|private[_-]?key)';
    $analyze_value = static function ($text) use (&$result, $scan_string, $sensitive_pattern) {
        if (strpos($text, chr(0)) !== false || !preg_match('//u', $text)) { $result['skippedBinaryValues']++; return; }
        $result['scannedValues']++;
        $serialized = is_serialized($text); // Detection only; never unserialize.
        $decoded = json_decode($text, true, 32, JSON_BIGINT_AS_STRING);
        if (json_last_error() === JSON_ERROR_NONE && (is_array($decoded) || is_string($decoded))) {
            $visit = static function ($value) use (&$visit, &$result, $scan_string, $sensitive_pattern) {
                if (is_string($value)) { $scan_string($value, false, true); }
                elseif (is_array($value)) {
                    foreach ($value as $key => $child) {
                        if (is_string($key) && preg_match('~' . $sensitive_pattern . '~i', $key)) { $result['skippedSensitiveValues']++; continue; }
                        $visit($child);
                    }
                }
            };
            $visit($decoded);
        } else { $scan_string($text, $serialized, false); }
    };
    $read_rows = static function ($sql) use ($wpdb) {
        $rows = $wpdb->get_results($sql, ARRAY_A);
        if ($wpdb->last_error || !is_array($rows)) { WP_CLI::error('Unable to read URL reference data. Check database access and compatibility.'); }
        return $rows;
    };
    $quote = static function ($name) { return chr(96) . str_replace(chr(96), chr(96) . chr(96), $name) . chr(96); };
    $locations = array(
        array($wpdb->posts, 'ID', 'post_content', null),
        array($wpdb->posts, 'ID', 'post_excerpt', null),
        array($wpdb->postmeta, 'meta_id', 'meta_value', 'meta_key'),
        array($wpdb->options, 'option_id', 'option_value', 'option_name'),
        array($wpdb->termmeta, 'meta_id', 'meta_value', 'meta_key'),
        array($wpdb->comments, 'comment_ID', 'comment_content', null),
        array($wpdb->commentmeta, 'meta_id', 'meta_value', 'meta_key')
    );
    foreach ($locations as $location) {
        list($table_name, $id_name, $column_name, $key_name) = $location;
        $table = $quote($table_name); $id = $quote($id_name); $column = $quote($column_name);
        $max_rows = $read_rows("SELECT MAX($id) AS max_id FROM $table");
        if (count($max_rows) !== 1 || !array_key_exists('max_id', $max_rows[0])) {
            WP_CLI::error('Unexpected reference ID range. Check database compatibility.');
        }
        $max_id = $max_rows[0]['max_id'];
        if ($max_id !== null && (!ctype_digit((string) $max_id) || (float) $max_id > 9007199254740991)) {
            WP_CLI::error('Reference row IDs exceed the safely supported range.');
        }
        $before = $result['totalReferences'];
        $sensitive = '0';
        if ($key_name !== null) {
            $key = $quote($key_name);
            $sensitive = $wpdb->prepare("(LOWER($key) REGEXP %s OR LEFT($key, 11) = '_transient_' OR LEFT($key, 16) = '_site_transient_')", $sensitive_pattern);
        }
        $after_id = -1;
        if ($max_id !== null) {
            do {
                // Do not transfer secret-keyed or oversized values out of MySQL.
                $page = $read_rows($wpdb->prepare("SELECT $id AS row_id,
                    CASE WHEN $sensitive THEN 'sensitive' WHEN OCTET_LENGTH($column) > 65536 THEN 'oversized' ELSE 'scan' END AS scan_state,
                    CASE WHEN $sensitive OR OCTET_LENGTH($column) > 65536 THEN NULL ELSE COALESCE($column, '') END AS text_value
                    FROM $table WHERE $id > %d AND $id <= %d ORDER BY $id LIMIT 100", $after_id, $max_id));
                foreach ($page as $row) {
                    if (!ctype_digit((string) $row['row_id']) || $row['row_id'] <= $after_id || $row['row_id'] > $max_id) {
                        WP_CLI::error('Unexpected reference page ordering. Retry on a stable installation.');
                    }
                    $after_id = $row['row_id'];
                    if ($row['scan_state'] === 'sensitive') { $result['skippedSensitiveValues']++; }
                    elseif ($row['scan_state'] === 'oversized') { $result['skippedOversizedValues']++; }
                    elseif ($row['scan_state'] === 'scan' && is_string($row['text_value'])) { $analyze_value($row['text_value']); }
                    else { WP_CLI::error('Unexpected textual reference data. Check database compatibility.'); }
                }
            } while (count($page) === 100 && $after_id < $max_id);
        }
        $result['locations'][] = array('source' => $table_name . '.' . $column_name, 'referenceCount' => $result['totalReferences'] - $before);
    }
    $result['hostCounts'] = (object) $result['hostCounts'];
    $result['externalMediaHostCounts'] = (object) $result['externalMediaHostCounts'];
    $result['alternateSourceHosts'] = array_keys($result['alternateSourceHosts']);
    echo wp_json_encode($result);
} finally { $wpdb->suppress_errors($previous_errors); }
`;
