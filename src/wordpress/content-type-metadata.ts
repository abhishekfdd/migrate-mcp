import { z } from 'zod';

const postCountSchema = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));

const contentTypeSchema = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  public: z.boolean(),
  publiclyQueryable: z.boolean(),
  hierarchical: z.boolean(),
  showUi: z.boolean(),
  showInRest: z.boolean(),
  restBase: z.string().optional(),
  // WordPress permits a custom archive slug as well as a boolean.
  hasArchive: z.union([z.boolean(), z.string()]),
  rewriteSlug: z.string().optional(),
  capabilityType: z.union([z.string(), z.array(z.string())]).optional(),
  supports: z.array(z.string().min(1)),
  builtIn: z.boolean(),
  postCount: postCountSchema,
});

export const contentTypeMetadataSchema = z
  .array(contentTypeSchema)
  .refine(
    (types) => new Set(types.map((type) => type.name)).size === types.length,
    'Post type names must be unique',
  );

export type WpContentTypeMetadata = z.infer<typeof contentTypeSchema>;

// Application-controlled PHP only. This inspects the fully loaded registry,
// including internal types, and reads counts without invoking status filters.
export const contentTypeMetadataPhp = `global $wpdb;
$types = get_post_types(array(), 'objects');
$previous_errors = $wpdb->suppress_errors(true);
try {
    $posts_table = str_replace(chr(96), chr(96) . chr(96), $wpdb->posts);
    $rows = $wpdb->get_results('SELECT post_type, COUNT(*) AS post_count FROM '
        . chr(96) . $posts_table . chr(96) . ' GROUP BY post_type', ARRAY_A);
    if ($wpdb->last_error || !is_array($rows)) {
        WP_CLI::error('Unable to count posts for content type analysis.');
    }
} finally {
    $wpdb->suppress_errors($previous_errors);
}
$counts = array();
foreach ($rows as $row) {
    $counts[$row['post_type']] = $row['post_count'];
}
$result = array();
foreach ($types as $type) {
    $item = array(
        'name' => $type->name,
        'public' => (bool) $type->public,
        'publiclyQueryable' => (bool) $type->publicly_queryable,
        'hierarchical' => (bool) $type->hierarchical,
        'showUi' => (bool) $type->show_ui,
        'showInRest' => (bool) $type->show_in_rest,
        'hasArchive' => $type->has_archive,
        'supports' => array_keys(get_all_post_type_supports($type->name)),
        'builtIn' => (bool) $type->_builtin,
        'postCount' => isset($counts[$type->name]) ? $counts[$type->name] : '0'
    );
    foreach (array('label' => 'label', 'description' => 'description', 'restBase' => 'rest_base') as $key => $property) {
        if (isset($type->$property) && is_string($type->$property)) {
            $item[$key] = $type->$property;
        }
    }
    if (is_array($type->rewrite) && isset($type->rewrite['slug'])) {
        $item['rewriteSlug'] = $type->rewrite['slug'];
    }
    if (isset($type->capability_type)) {
        $item['capabilityType'] = $type->capability_type;
    }
    $result[] = $item;
}
echo wp_json_encode($result);`;
