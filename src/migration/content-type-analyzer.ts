import type { WpContentTypeMetadata } from '../wordpress/content-type-metadata.js';
import type { WpCliClient } from '../wordpress/wp-cli-client.js';

/** Runtime metadata for a registered type; counts include every post status. */
export type ContentTypeInfo = WpContentTypeMetadata;

export class ContentTypeAnalyzer {
  constructor(
    private readonly client: Pick<WpCliClient, 'getContentTypeMetadata'>,
  ) {}

  async analyze(): Promise<ContentTypeInfo[]> {
    const types = await this.client.getContentTypeMetadata();
    // Use code-unit ordering instead of locale-dependent collation.
    return types
      .map((type) => ({ ...type, supports: [...type.supports].sort() }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
}
