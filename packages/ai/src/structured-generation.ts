import type {
  AiOperationSnapshot,
  JsonObject,
  JsonValue,
  RawProviderResponse,
  TokenUsage,
} from './common.js';

export type GenerationMessage = Readonly<{
  role: 'assistant' | 'system' | 'user';
  content: string;
}>;

export type StructuredOutputSchema<T extends JsonValue> = Readonly<{
  id: string;
  version: string;
  jsonSchema: JsonObject;
  /** Adapters use this to ensure only validated output crosses the port. */
  parse: (value: unknown) => T;
}>;

export type PromptSnapshot = Readonly<{
  id: string;
  version: string;
  templateHash: string;
}>;

export type StructuredGenerationRequest<T extends JsonValue> = Readonly<{
  messages: readonly GenerationMessage[];
  outputSchema: StructuredOutputSchema<T>;
  prompt: PromptSnapshot;
  configuration: JsonObject;
}>;

export type StructuredGenerationResult<T extends JsonValue> = Readonly<{
  data: T;
  schema: Readonly<{ id: string; version: string }>;
  prompt: PromptSnapshot;
  /** The exact messages actually sent after any provider limits are applied. */
  effectiveMessages: readonly GenerationMessage[];
  usage: TokenUsage;
  operation: AiOperationSnapshot;
  rawResponse: RawProviderResponse;
}>;

/** Capability port for schema-validated generation. */
export interface StructuredGenerationProvider {
  generate<T extends JsonValue>(
    request: StructuredGenerationRequest<T>,
  ): Promise<StructuredGenerationResult<T>>;
}
