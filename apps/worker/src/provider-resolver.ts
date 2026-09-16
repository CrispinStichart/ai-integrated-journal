import {
  AiProviderFactoryRegistry,
  AiProviderOperationError,
  providerDisclosureVersion,
  type AiCapability,
  type AiCapabilityPorts,
  type CapabilityResolution,
  type ProviderCredentialCipher,
} from '@journal/ai';
import { ProviderExecutionRepository } from '@journal/database';

export class OwnerProviderResolver {
  public constructor(
    private readonly repository: Pick<
      ProviderExecutionRepository,
      'get' | 'recordingOwner' | 'journalDayOwner'
    >,
    private readonly providers: AiProviderFactoryRegistry,
    private readonly cipher?: ProviderCredentialCipher,
  ) {}

  public async forRecording<C extends AiCapability>(
    recordingId: string,
    configuration: Readonly<Record<string, unknown>>,
    capability: C,
  ): Promise<CapabilityResolution<AiCapabilityPorts[C]>> {
    return this.resolve(
      await this.repository.recordingOwner(recordingId),
      configuration,
      capability,
    );
  }
  public async forJournalDay<C extends AiCapability>(
    journalDayId: string | null,
    configuration: Readonly<Record<string, unknown>>,
    capability: C,
  ): Promise<CapabilityResolution<AiCapabilityPorts[C]>> {
    return this.resolve(
      journalDayId === null
        ? undefined
        : await this.repository.journalDayOwner(journalDayId),
      configuration,
      capability,
    );
  }
  public async resolve<C extends AiCapability>(
    ownerId: string | undefined,
    configuration: Readonly<Record<string, unknown>>,
    capability: C,
  ): Promise<CapabilityResolution<AiCapabilityPorts[C]>> {
    const providerId = configuration.providerId ?? 'openai';
    if (typeof providerId !== 'string' || !ownerId)
      throw new AiProviderOperationError({
        code: 'provider_invalid_request',
        retryable: false,
      });
    const descriptor = this.providers
      .listProviders()
      .find((item) => item.id === providerId);
    if (!descriptor)
      return {
        status: 'unavailable',
        providerId,
        capability,
        reason: 'provider_not_registered',
      };
    if (!descriptor.capabilities.includes(capability))
      return {
        status: 'unavailable',
        providerId,
        capability,
        reason: 'capability_not_supported',
      };
    const row = await this.repository.get(ownerId, providerId);
    if (
      !row?.configuration.enabled ||
      !row.configuration.disclosureAcceptedAt ||
      row.configuration.disclosureVersion !==
        providerDisclosureVersion(descriptor)
    )
      return {
        status: 'unavailable',
        providerId,
        capability,
        reason: 'provider_disabled',
      };
    const model = row.configuration.models[capability];
    if (!model?.trim())
      throw new AiProviderOperationError({
        code: 'provider_invalid_request',
        retryable: false,
      });
    if (!row.credential || !this.cipher)
      throw new AiProviderOperationError({
        code: 'provider_authentication_failed',
        retryable: false,
      });
    return this.providers.resolve(
      {
        providerId,
        enabled: true,
        settings: {
          models: { [capability]: model },
          apiKey: this.cipher.decrypt(ownerId, providerId, row.credential),
        },
      },
      capability,
    );
  }
}
