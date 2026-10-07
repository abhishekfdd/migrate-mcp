import {
  attachmentFilePageSize,
  attachmentFilePathLimit,
} from './media-metadata.js';

// Fixed read-only SQL, with table identifiers from the active WordPress runtime.
const inspectionStart = `global $wpdb;
if (PHP_INT_SIZE < 8) {
    WP_CLI::error('Media analysis requires a 64-bit PHP runtime.');
}
$previous_errors = $wpdb->suppress_errors(true);
try {
    $posts = chr(96) . str_replace(chr(96), chr(96) . chr(96), $wpdb->posts) . chr(96);
    $meta = chr(96) . str_replace(chr(96), chr(96) . chr(96), $wpdb->postmeta) . chr(96);
    $read_rows = static function ($sql) use ($wpdb) {
        $rows = $wpdb->get_results($sql, ARRAY_A);
        if ($wpdb->last_error || !is_array($rows)) {
            WP_CLI::error('Unable to read media analysis data. Check database access and compatibility.');
        }
        return $rows;
    };
    // Select one deterministic value per attachment, even if duplicate meta exists.
    $file_join = "LEFT JOIN $meta f ON f.meta_id = (SELECT MIN(m.meta_id) FROM $meta m
        WHERE m.post_id = p.ID AND m.meta_key = '_wp_attached_file')";`;

const inspectionEnd = `
} finally {
    $wpdb->suppress_errors($previous_errors);
}`;

export const mediaMetadataPhp = `${inspectionStart}
    $totals = $read_rows("SELECT COUNT(*) AS totalAttachments,
        MIN(p.ID) AS minAttachmentId, MAX(p.ID) AS maxAttachmentId,
        COALESCE(SUM(CASE WHEN f.meta_id IS NULL OR OCTET_LENGTH(f.meta_value) = 0 THEN 1 ELSE 0 END), 0) AS missingAttachedFileMeta,
        COALESCE(SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM $meta m WHERE m.post_id = p.ID
            AND m.meta_key = '_wp_attachment_metadata' AND OCTET_LENGTH(m.meta_value) > 0) THEN 1 ELSE 0 END), 0) AS missingAttachmentMetadata,
        COALESCE(SUM(CASE WHEN p.post_parent = 0 THEN 1 ELSE 0 END), 0) AS unattachedAttachments,
        COALESCE(SUM(CASE WHEN p.post_parent <> 0 AND NOT EXISTS
            (SELECT 1 FROM $posts parent WHERE parent.ID = p.post_parent) THEN 1 ELSE 0 END), 0) AS orphanedAttachments,
        COALESCE(SUM(CASE WHEN LOWER(f.meta_value) REGEXP '^(https?|ftp|s3|gs)://|^//' THEN 1 ELSE 0 END), 0) AS externalMediaCount
        FROM $posts p $file_join WHERE p.post_type = 'attachment'");
    $result = $totals[0];
    $mime_rows = $read_rows("SELECT BINARY post_mime_type AS mime, COUNT(*) AS n FROM $posts
        WHERE post_type = 'attachment' GROUP BY BINARY post_mime_type");
    $mimes = array();
    foreach ($mime_rows as $row) { $mimes[$row['mime']] = $row['n']; }
    $result['mimeTypeCounts'] = (object) $mimes;
    $result['multisite'] = (bool) is_multisite();
    $result['siteId'] = get_current_blog_id();
    // The false argument explicitly disables directory creation.
    $uploads = wp_upload_dir(null, false);
    if (empty($uploads['error'])) {
        if (!empty($uploads['basedir']) && is_string($uploads['basedir'])) { $result['uploadBaseDir'] = $uploads['basedir']; }
        if (!empty($uploads['baseurl']) && is_string($uploads['baseurl'])) { $result['uploadBaseUrl'] = $uploads['baseurl']; }
    }
    $year_month = get_option('uploads_use_yearmonth_folders', null);
    if ($year_month !== null) { $result['usesYearMonthFolders'] = (string) $year_month === '1'; }
    echo wp_json_encode($result);
${inspectionEnd}`;

export function attachmentFileReferencesPhp(
  afterId: number,
  throughId: number,
): string {
  if (
    !Number.isSafeInteger(afterId) ||
    afterId < -1 ||
    !Number.isSafeInteger(throughId) ||
    throughId < 0 ||
    afterId > throughId
  ) {
    throw new TypeError('Attachment cursors must be ordered safe integer IDs');
  }
  // Only validated integers enter application-owned PHP; no caller code or SQL.
  return `${inspectionStart}
    $rows = $read_rows($wpdb->prepare("SELECT p.ID AS id,
        CASE WHEN OCTET_LENGTH(f.meta_value) > ${attachmentFilePathLimit} THEN NULL ELSE COALESCE(f.meta_value, '') END AS attachedFile
        FROM $posts p $file_join WHERE p.post_type = 'attachment' AND p.ID > %d AND p.ID <= %d
        ORDER BY p.ID LIMIT ${attachmentFilePageSize}", ${afterId}, ${throughId}));
    echo wp_json_encode($rows);
${inspectionEnd}`;
}
