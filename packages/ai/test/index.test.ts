import { describe, expect, it, vi } from 'vitest';

import {
  AiProviderOperationError,
  AiProviderFactoryRegistry,
  DuplicateAiProviderError,
  aiPackageName,
  type AiProviderDescriptor,
  type AiProviderFactory,
  type SpeechToTextProvider,
} from '../src/index.js';

const descriptor: AiProviderDescriptor = Object.freeze({
  id: 'local-fixture',
  displayName: 'Local fixture',
  capabilities: Object.freeze(['speech_to_text'] as const),
  disclosure: Object.freeze({
    contentRecipient: 'This process',
    external: false,
    retention: { status: 'known' as const, value: 'No retention' },
    trainingUse: { status: 'known' as const, value: false },
  }),
});

const speechPort: SpeechToTextProvider = {
  transcribe: vi.fn(),
};

function factory(
  overrides: Partial<AiProviderFactory> = {},
): AiProviderFactory {
  return {
    descriptor,
    create: () => ({ descriptor, speech_to_text: speechPort }),
    ...overrides,
  };
}

const enabledSelection = Object.freeze({
  providerId: descriptor.id,
  enabled: true,
  settings: Object.freeze({}),
});

describe('@journal/ai provider-neutral ports', () => {
  it('exposes its package identity', () => {
    expect(aiPackageName).toBe('@journal/ai');
  });

  it('MODEL-001 resolves a capability port without a provider SDK type', async () => {
    const registry = new AiProviderFactoryRegistry([factory()]);
    const resolution = await registry.resolve(
      enabledSelection,
      'speech_to_text',
    );

    expect(resolution).toEqual({ status: 'available', port: speechPort });
  });

  it('MODEL-003 lists side-by-side providers in stable order', () => {
    const laterDescriptor = { ...descriptor, id: 'z-provider' };
    const registry = new AiProviderFactoryRegistry([
      {
        descriptor: laterDescriptor,
        create: () => ({ descriptor: laterDescriptor }),
      },
      factory(),
    ]);

    expect(registry.listProviders().map(({ id }) => id)).toEqual([
      'local-fixture',
      'z-provider',
    ]);
  });

  it.each([
    {
      name: 'unregistered provider',
      registry: new AiProviderFactoryRegistry(),
      selection: enabledSelection,
      capability: 'speech_to_text' as const,
      reason: 'provider_not_registered',
    },
    {
      name: 'disabled provider',
      registry: new AiProviderFactoryRegistry([factory()]),
      selection: { ...enabledSelection, enabled: false },
      capability: 'speech_to_text' as const,
      reason: 'provider_disabled',
    },
    {
      name: 'unsupported capability',
      registry: new AiProviderFactoryRegistry([factory()]),
      selection: enabledSelection,
      capability: 'embeddings' as const,
      reason: 'capability_not_supported',
    },
  ])('MODEL-004 represents $name as explicit absence', async (fixture) => {
    await expect(
      fixture.registry.resolve(fixture.selection, fixture.capability),
    ).resolves.toMatchObject({
      status: 'unavailable',
      capability: fixture.capability,
      reason: fixture.reason,
    });
  });

  it('SEC-004 exposes provider capability and data-use disclosure before creation', () => {
    const create = vi.fn(() => ({ descriptor }));
    const registry = new AiProviderFactoryRegistry([factory({ create })]);

    expect(registry.listProviders()).toEqual([descriptor]);
    expect(registry.listProviders()[0]?.disclosure).toMatchObject({
      contentRecipient: 'This process',
      external: false,
      trainingUse: { status: 'known', value: false },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects duplicate registrations and mismatched adapter identities', async () => {
    expect(() => new AiProviderFactoryRegistry([factory(), factory()])).toThrow(
      DuplicateAiProviderError,
    );

    const registry = new AiProviderFactoryRegistry([
      factory({
        create: () => ({
          descriptor: { ...descriptor, id: 'unexpected-provider' },
        }),
      }),
    ]);
    await expect(
      registry.resolve(enabledSelection, 'speech_to_text'),
    ).rejects.toThrow('adapter with a different ID');
  });

  it('[STATE-003][SEC-007] represents retry policy with content-free provider failure metadata', () => {
    const rateLimit = new AiProviderOperationError({
      code: 'provider_rate_limited',
      retryable: true,
      retryAfterMilliseconds: 2_500,
    });

    expect(rateLimit).toMatchObject({
      name: 'AiProviderOperationError',
      message: 'AI provider operation failed.',
      code: 'provider_rate_limited',
      retryable: true,
      retryAfterMilliseconds: 2_500,
    });
    expect(JSON.stringify(rateLimit)).not.toContain('journal');
    expect(
      () =>
        new AiProviderOperationError({
          code: 'provider_timeout',
          retryable: true,
          retryAfterMilliseconds: -1,
        }),
    ).toThrow(RangeError);
  });
});
