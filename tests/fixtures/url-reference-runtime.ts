// PHP-only harness: WordPress, database reads, upload configuration, and options
// are fake. No WordPress bootstrap, database connection, or network access occurs.
export const urlReferenceRuntimePhp = String.raw`
$fixture = json_decode(base64_decode($argv[1]), true);
define('ARRAY_A', 'ARRAY_A');
class WP_CLI {
    public static function error($message) { fwrite(STDERR, $message); exit(1); }
}
class UrlProbe {
    public function __wakeup() { WP_CLI::error('Unsafe deserialization'); }
}
function is_multisite() { global $fixture; return $fixture['multisite'] ?? false; }
function get_current_blog_id() { global $fixture; return $fixture['siteId'] ?? 1; }
function get_option($key) { global $fixture; return $fixture['options'][$key] ?? null; }
function wp_upload_dir($time, $create) {
    global $fixture;
    if ($create !== false) { WP_CLI::error('Directory creation requested'); }
    return $fixture['uploads'] ?? array('error' => 'Unavailable');
}
function wp_json_encode($value) { return json_encode($value); }
function is_serialized($value) { return preg_match('/^(?:a|O|s|C):[0-9]+:/', trim($value)) === 1; }
class FakeReferenceDatabase {
    public $posts; public $postmeta; public $options; public $termmeta; public $comments; public $commentmeta;
    public $last_error = ''; public $queries = array(); public $suppressed = false;
    public function __construct($prefix) {
        foreach (array('posts', 'postmeta', 'options', 'termmeta', 'comments', 'commentmeta') as $name) { $this->$name = $prefix . $name; }
    }
    public function suppress_errors($value) { $old = $this->suppressed; $this->suppressed = $value; return $old; }
    public function prepare($sql, ...$args) {
        $index = 0;
        return preg_replace_callback('/%[ds]/', static function ($match) use (&$index, $args) {
            $value = $args[$index++];
            return $match[0] === '%d' ? (string) (int) $value : "'" . str_replace("'", "''", $value) . "'";
        }, $sql);
    }
    public function get_results($sql, $format) {
        global $fixture;
        $this->queries[] = $sql;
        if (!empty($fixture['queryFailure'])) { $this->last_error = 'private credentials'; return null; }
        if (preg_match('/^SELECT MAX\(\x60[^\x60]+\x60\) AS max_id FROM \x60([^\x60]+)\x60$/D', $sql, $m)) {
            $ids = array();
            foreach (($fixture['values'] ?? array()) as $source => $rows) {
                if (strpos($source, $m[1] . '.') === 0) {
                    foreach ($rows as $row) { $ids[] = $row['id']; }
                }
            }
            return array(array('max_id' => $ids ? max($ids) : null));
        }
        if (!preg_match('/FROM \x60([^\x60]+)\x60 WHERE \x60[^\x60]+\x60 > (-?[0-9]+) AND \x60[^\x60]+\x60 <= ([0-9]+) ORDER BY \x60[^\x60]+\x60 LIMIT 100/', $sql, $m)
            || !preg_match('/OCTET_LENGTH\(\x60([^\x60]+)\x60\)/', $sql, $column)) { WP_CLI::error('Unexpected fixture query'); }
        $rows = $fixture['values'][$m[1] . '.' . $column[1]] ?? array();
        usort($rows, static function ($a, $b) { return $a['id'] <=> $b['id']; });
        $page = array();
        foreach ($rows as $row) {
            if ($row['id'] <= $m[2] || $row['id'] > $m[3]) { continue; }
            $key = $row['key'] ?? '';
            $sensitive = preg_match("/REGEXP '([^']+)'/", $sql, $pattern) &&
                (preg_match('~' . $pattern[1] . '~i', $key) || strpos($key, '_transient_') === 0 || strpos($key, '_site_transient_') === 0);
            $state = $sensitive ? 'sensitive' : (strlen($row['text'] ?? '') > 65536 ? 'oversized' : 'scan');
            $page[] = array('row_id' => (string) $row['id'], 'scan_state' => $state, 'text_value' => $state === 'scan' ? ($row['text'] ?? '') : null);
            if (count($page) === 100) { break; }
        }
        return $page;
    }
}
$wpdb = new FakeReferenceDatabase($fixture['prefix'] ?? 'wp_');
`;
