/** JSON-compatible values accepted at provider-neutral boundaries. */
export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = Readonly<Record<string, JsonValue>>;

export type AiCapability =
  'embeddings' | 'speech_to_text' | 'structured_generation';

export type KnownOrUnknown<T> =
  Readonly<{ status: 'known'; value: T }> | Readonly<{ status: 'unknown' }>;

/** Provider identity captured with every operation, independent of an SDK. */
export type ProviderSnapshot = Readonly<{
  id: string;
  displayName: string;
  adapterVersion?: string;
}>;

/** Exact configured model identity captured with every operation. */
export type ModelSnapshot = Readonly<{
  id: string;
  displayName?: string;
  version?: string;
}>;

/** Public, secret-free effective parameters and their stable fingerprint. */
export type ConfigurationSnapshot = Readonly<{
  parameters: JsonObject;
  fingerprint: string;
}>;

export type AiOperationSnapshot = Readonly<{
  provider: ProviderSnapshot;
  model: ModelSnapshot;
  configuration: ConfigurationSnapshot;
  processingTimeMs: number;
}>;

export type RawProviderResponse = Readonly<{
  /** Exact response body bytes; adapters must not normalize or reserialize it. */
  body: Uint8Array;
  mediaType: string;
  providerRequestId?: string;
}>;

export type TokenUsage =
  | Readonly<{
      status: 'known';
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }>
  | Readonly<{ status: 'unknown' }>;

export type ProviderDisclosureValue<T> =
  | Readonly<{ status: 'known'; value: T; detail?: string }>
  | Readonly<{ status: 'unknown'; detail?: string }>;

/** Information shown before an external provider is enabled. */
export type ProviderDisclosure = Readonly<{
  contentRecipient: string;
  external: boolean;
  retention: ProviderDisclosureValue<string>;
  trainingUse: ProviderDisclosureValue<boolean>;
  privacyPolicyUrl?: string;
}>;

export type AiProviderDescriptor = Readonly<{
  id: string;
  displayName: string;
  capabilities: readonly AiCapability[];
  disclosure: ProviderDisclosure;
}>;
