import { z } from 'zod';

const termCountSchema = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));

const taxonomySchema = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  public: z.boolean(),
  publiclyQueryable: z.boolean(),
  hierarchical: z.boolean(),
  showUi: z.boolean(),
  showInRest: z.boolean(),
  restBase: z.string().optional(),
  rewriteSlug: z.string().optional(),
  builtIn: z.boolean(),
  objectTypes: z.array(z.string().min(1)),
  termCount: termCountSchema,
});

export const taxonomyMetadataSchema = z
  .array(taxonomySchema)
  .refine(
    (taxonomies) =>
      new Set(taxonomies.map((taxonomy) => taxonomy.name)).size ===
      taxonomies.length,
    'Taxonomy names must be unique',
  );

export type WpTaxonomyMetadata = z.infer<typeof taxonomySchema>;

// Application-controlled PHP only. Count stored taxonomy terms, including unused
// terms, without invoking term-query filters or rebuilding term hierarchy caches.
export const taxonomyMetadataPhp = `global $wpdb;
$taxonomies = get_taxonomies(array(), 'objects');
$previous_errors = $wpdb->suppress_errors(true);
try {
    $taxonomy_table = str_replace(chr(96), chr(96) . chr(96), $wpdb->term_taxonomy);
    $rows = $wpdb->get_results('SELECT taxonomy, COUNT(*) AS term_count FROM '
        . chr(96) . $taxonomy_table . chr(96) . ' GROUP BY taxonomy', ARRAY_A);
    if ($wpdb->last_error || !is_array($rows)) {
        WP_CLI::error('Unable to count terms for taxonomy analysis.');
    }
} finally {
    $wpdb->suppress_errors($previous_errors);
}
$counts = array();
foreach ($rows as $row) {
    $counts[$row['taxonomy']] = $row['term_count'];
}
$result = array();
foreach ($taxonomies as $taxonomy) {
    $item = array(
        'name' => $taxonomy->name,
        'public' => (bool) $taxonomy->public,
        'publiclyQueryable' => (bool) $taxonomy->publicly_queryable,
        'hierarchical' => (bool) $taxonomy->hierarchical,
        'showUi' => (bool) $taxonomy->show_ui,
        'showInRest' => (bool) $taxonomy->show_in_rest,
        'builtIn' => (bool) $taxonomy->_builtin,
        'objectTypes' => array_values($taxonomy->object_type),
        'termCount' => isset($counts[$taxonomy->name]) ? $counts[$taxonomy->name] : '0'
    );
    foreach (array('label' => 'label', 'description' => 'description', 'restBase' => 'rest_base') as $key => $property) {
        if (isset($taxonomy->$property) && is_string($taxonomy->$property)) {
            $item[$key] = $taxonomy->$property;
        }
    }
    if (is_array($taxonomy->rewrite) && isset($taxonomy->rewrite['slug'])) {
        $item['rewriteSlug'] = $taxonomy->rewrite['slug'];
    }
    $result[] = $item;
}
echo wp_json_encode($result);`;
