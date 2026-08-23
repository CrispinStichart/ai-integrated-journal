import type {
  AiCapability,
  AiProviderDescriptor,
  JsonObject,
} from './common.js';
import type { EmbeddingProvider } from './embeddings.js';
import type { SpeechToTextProvider } from './speech-to-text.js';
import type { StructuredGenerationProvider } from './structured-generation.js';

export type AiCapabilityPorts = Readonly<{
  embeddings: EmbeddingProvider;
  speech_to_text: SpeechToTextProvider;
  structured_generation: StructuredGenerationProvider;
}>;

export type AiProviderAdapter = Readonly<{
  descriptor: AiProviderDescriptor;
}> & {
  readonly [Capability in AiCapability]?: AiCapabilityPorts[Capability];
};

export type AiProviderSelection = Readonly<{
  providerId: string;
  enabled: boolean;
  /** Adapter-owned settings; factories must keep secrets out of snapshots. */
  settings: JsonObject;
}>;

export interface AiProviderFactory {
  readonly descriptor: AiProviderDescriptor;
  create(settings: JsonObject): AiProviderAdapter | Promise<AiProviderAdapter>;
}

export type CapabilityUnavailableReason =
  'capability_not_supported' | 'provider_disabled' | 'provider_not_registered';

export type CapabilityResolution<T> =
  | Readonly<{ status: 'available'; port: T }>
  | Readonly<{
      status: 'unavailable';
      providerId: string;
      capability: AiCapability;
      reason: CapabilityUnavailableReason;
    }>;

export class DuplicateAiProviderError extends Error {
  public constructor(providerId: string) {
    super(`AI provider factory is already registered: ${providerId}`);
    this.name = 'DuplicateAiProviderError';
  }
}

/** Registry/factory boundary used by composition roots to select adapters. */
export class AiProviderFactoryRegistry {
  readonly #factories = new Map<string, AiProviderFactory>();

  public constructor(factories: readonly AiProviderFactory[] = []) {
    for (const factory of factories) this.register(factory);
  }

  public register(factory: AiProviderFactory): void {
    const providerId = factory.descriptor.id;
    if (this.#factories.has(providerId)) {
      throw new DuplicateAiProviderError(providerId);
    }
    this.#factories.set(providerId, factory);
  }

  public listProviders(): readonly AiProviderDescriptor[] {
    return [...this.#factories.values()]
      .map(({ descriptor }) => descriptor)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  public async resolve<Capability extends AiCapability>(
    selection: AiProviderSelection,
    capability: Capability,
  ): Promise<CapabilityResolution<AiCapabilityPorts[Capability]>> {
    const factory = this.#factories.get(selection.providerId);
    if (factory === undefined) {
      return {
        status: 'unavailable',
        providerId: selection.providerId,
        capability,
        reason: 'provider_not_registered',
      };
    }
    if (!selection.enabled) {
      return {
        status: 'unavailable',
        providerId: selection.providerId,
        capability,
        reason: 'provider_disabled',
      };
    }

    const adapter = await factory.create(selection.settings);
    if (adapter.descriptor.id !== factory.descriptor.id) {
      throw new Error(
        'AI provider factory returned an adapter with a different ID.',
      );
    }
    const port = adapter[capability] as
      AiCapabilityPorts[Capability] | undefined;
    if (port === undefined) {
      return {
        status: 'unavailable',
        providerId: selection.providerId,
        capability,
        reason: 'capability_not_supported',
      };
    }
    return { status: 'available', port };
  }
}
