import type { JsonObject } from './common.js';

/** Shared secret-free configuration used for corpus and query embeddings. */
export const SEMANTIC_SEARCH_EMBEDDING_CONFIGURATION: JsonObject =
  Object.freeze({
    purpose: 'semantic_search',
    inputType: 'passage_or_query',
    version: 1,
  });
