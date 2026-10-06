import type { WpTaxonomyMetadata } from '../wordpress/taxonomy-metadata.js';
import type { WpCliClient } from '../wordpress/wp-cli-client.js';

/** Runtime taxonomy metadata; term counts include unused terms on the active site. */
export type TaxonomyInfo = WpTaxonomyMetadata;

export class TaxonomyAnalyzer {
  constructor(
    private readonly client: Pick<WpCliClient, 'getTaxonomyMetadata'>,
  ) {}

  async analyze(): Promise<TaxonomyInfo[]> {
    const taxonomies = await this.client.getTaxonomyMetadata();
    // Use code-unit ordering instead of locale-dependent collation.
    return taxonomies
      .map((taxonomy) => ({
        ...taxonomy,
        objectTypes: [...taxonomy.objectTypes].sort(),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
}
