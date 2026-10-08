// Application-owned PHP helpers. They never evaluate or deserialize database values.
export const urlReferenceParserPhp = String.raw`
$parse_reference = static function ($url) {
    if (!is_string($url) || strlen($url) > 8192 || preg_match('~[\x00-\x20\x7f\\\\]~', $url)) { return null; }
    $relative = substr($url, 0, 2) === '//';
    $parts = parse_url($relative ? 'https:' . $url : $url);
    if (!is_array($parts) || empty($parts['host']) || !isset($parts['scheme'])) { return null; }
    $scheme = strtolower($parts['scheme']);
    if ($scheme !== 'http' && $scheme !== 'https') { return null; }
    $raw_host = strtolower($parts['host']);
    if ($raw_host[0] === '[' || substr($raw_host, -1) === ']') {
        if ($raw_host[0] !== '[' || substr($raw_host, -1) !== ']' || !filter_var(substr($raw_host, 1, -1), FILTER_VALIDATE_IP, FILTER_FLAG_IPV6)) { return null; }
        $host = substr($raw_host, 1, -1);
    } else { $host = rtrim($raw_host, '.'); }
    $ip = filter_var($host, FILTER_VALIDATE_IP);
    if (!$ip) {
        if (strlen($host) > 253 || preg_match('/^[0-9.]+$/D', $host)) { return null; }
        foreach (explode('.', $host) as $label) {
            if (!preg_match('/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/D', $label)) { return null; }
        }
        // Avoid interpreting ordinary //code comments as host references.
        if ($relative && strpos($host, '.') === false && $host !== 'localhost') { return null; }
    }
    $port = $parts['port'] ?? null;
    if ($port !== null && ($port < 1 || $port > 65535)) { return null; }
    if (($scheme === 'http' && $port === 80) || ($scheme === 'https' && $port === 443)) { $port = null; }
    $path = $parts['path'] ?? '/';
    $display_host = strpos($host, ':') === false ? $host : '[' . $host . ']';
    return array('host' => $host, 'scheme' => $scheme, 'relative' => $relative, 'port' => $port, 'path' => $path,
        // Configuration URLs only: omit userinfo, query parameters, and fragments.
        'publicUrl' => $scheme . '://' . $display_host . ($port === null ? '' : ':' . $port) . $path);
};
$matches_base = static function ($url, $base) {
    if ($base === null || $url['host'] !== $base['host'] || $url['port'] !== $base['port']) { return false; }
    $path = rtrim($base['path'], '/');
    return $path === '' || $url['path'] === $path || strpos($url['path'], $path . '/') === 0;
};
$reference_pattern = '~(?<![a-z0-9_:/])(?:https?://|//)[^\s<>"\x27\x60\\\\]+~i';
$scan_string = static function ($text, $serialized, $json) use (&$result, &$configured, &$source_hosts, &$alternate_hosts, $parse_reference, $matches_base, $reference_pattern) {
    // Also recognize common escaped slashes in malformed JSON or serialized JSON strings.
    $text = html_entity_decode(str_replace('\/', '/', $text), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $matched = preg_match_all($reference_pattern, $text, $matches);
    if ($matched === false) { WP_CLI::error('URL pattern analysis failed. Check PHP compatibility.'); }
    foreach ($matches[0] as $candidate) {
        $url = $parse_reference(rtrim($candidate, '.,;!)}'));
        if ($url === null) { $result['malformedUrlReferences']++; continue; }
        $host = $url['host'];
        $result['totalReferences']++;
        $result[$url['relative'] ? 'protocolRelativeReferences' : ($url['scheme'] === 'http' ? 'httpReferences' : 'httpsReferences')]++;
        $source = isset($source_hosts[$host]);
        $result[$source ? 'sourceUrlReferences' : 'externalUrlReferences']++;
        if ($serialized) { $result['serializedValueReferences']++; }
        if ($json) { $result['jsonValueReferences']++; }
        foreach ($configured as $field => $base) {
            if ($matches_base($url, $base)) { $result[$field . 'References']++; }
        }
        if (!$source && isset($alternate_hosts[$host])) { $result['alternateSourceHosts'][$host] = true; }
        if ($host === 'localhost' || $host === '::1' || (filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) && strpos($host, '127.') === 0)
            || preg_match('/(?:^|\.)(?:localhost|local|test)$/D', $host)
            || preg_match('/(?:^|[.-])(?:dev|development|stage|staging)(?:[.-]|$)/', $host)) {
            $result['developmentReferenceCount']++;
        }
        $media = !$source && ($matches_base($url, $configured['uploadUrl'])
            || preg_match('/(?:^|\.)(?:cloudfront\.net|cloudinary\.com|imagekit\.io)$/D', $host)
            || preg_match('/(?:^|\.)cdn[.-]/', $host)
            || preg_match('/\.(?:jpe?g|png|gif|webp|avif|svg|mp[34]|webm|ogg|wav)$/iD', $url['path']));
        if (isset($result['hostCounts'][$host]) || count($result['hostCounts']) < 1000) {
            $result['hostCounts'][$host] = ($result['hostCounts'][$host] ?? 0) + 1;
            if ($media) { $result['externalMediaHostCounts'][$host] = ($result['externalMediaHostCounts'][$host] ?? 0) + 1; }
        } else { $result['unreportedHostReferences']++; }
        if ($media) { $result['externalMediaReferences']++; }
    }
    // Mask URL tokens first, so a URL's /var/... path is not a filesystem hint.
    $without_urls = preg_replace($reference_pattern, ' ', $text);
    $paths = preg_match_all('~(?<![a-z0-9:/\\\\])(?:/(?:var|home|srv|opt|Users|mnt|Volumes|etc|tmp|data|www)/[^\s<>"\x27]+|[a-z]:[\\\\/][^\s<>"\x27]+)~i', $without_urls);
    if ($paths === false) { WP_CLI::error('Path pattern analysis failed. Check PHP compatibility.'); }
    $result['filesystemPathReferences'] += $paths;
};
`;
