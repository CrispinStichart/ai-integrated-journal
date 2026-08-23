import type {
  AiOperationSnapshot,
  JsonObject,
  RawProviderResponse,
  TokenUsage,
} from './common.js';

export type EmbeddingFragment = Readonly<{
  id: string;
  text: string;
}>;

export type EmbeddingRequest = Readonly<{
  fragments: readonly EmbeddingFragment[];
  configuration: JsonObject;
}>;

export type NormalizedEmbedding = Readonly<{
  fragmentId: string;
  vector: readonly number[];
}>;

export type EmbeddingResult = Readonly<{
  embeddings: readonly NormalizedEmbedding[];
  dimension: number;
  usage: TokenUsage;
  operation: AiOperationSnapshot;
  rawResponse: RawProviderResponse;
}>;

/** Capability port for batched provider-neutral vector generation. */
export interface EmbeddingProvider {
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}
