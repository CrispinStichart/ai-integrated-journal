import {
  createCipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';

import type { AiProviderDescriptor } from '@journal/ai';
import type {
  ProviderCapability,
  ProviderSettings,
  SettingsResource,
  UpdateProviderSettingsRequest,
  UpdateSettingsRequest,
} from '@journal/contracts';
import {
  SettingsRepository,
  settingsRequestHash,
  type EncryptedProviderCredential,
  type JournalDatabase,
} from '@journal/database';
import { parseIanaTimezone } from '@journal/domain';

export class SettingsValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}

export interface ProviderCredentialCipher {
  encrypt(
    ownerId: string,
    providerId: string,
    value: string,
  ): EncryptedProviderCredential;
  fingerprint(value: string): string;
}

export function createProviderCredentialCipher(
  base64UrlKey: string,
): ProviderCredentialCipher {
  const key = Buffer.from(base64UrlKey, 'base64url');
  if (key.byteLength !== 32)
    throw new SettingsValidationError(
      'Provider credential encryption requires a 256-bit key.',
    );
  return {
    encrypt(ownerId, providerId, value) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(
        Buffer.from(`provider-credential:v1:${ownerId}:${providerId}`),
      );
      const ciphertext = Buffer.concat([
        cipher.update(value, 'utf8'),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return {
        ciphertext: ciphertext.toString('base64url'),
        nonce: nonce.toString('base64url'),
        encryptionVersion: 1,
      };
    },
    fingerprint(value) {
      return createHmac('sha256', key)
        .update('provider-credential-idempotency:v1:')
        .update(value)
        .digest('hex');
    },
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function providerDisclosureVersion(
  descriptor: AiProviderDescriptor,
): string {
  return createHash('sha256')
    .update(canonicalJson(descriptor.disclosure))
    .digest('hex');
}

export interface SettingsService {
  get(ownerId: string): Promise<SettingsResource>;
  update(
    ownerId: string,
    expectedRevision: number,
    request: UpdateSettingsRequest,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<{ settings: SettingsResource; replayed: boolean }>;
  updateProvider(
    ownerId: string,
    providerId: string,
    expectedRevision: number,
    request: UpdateProviderSettingsRequest,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<{ provider: ProviderSettings; replayed: boolean }>;
}

export class PostgresSettingsService implements SettingsService {
  readonly #repository: Pick<
    SettingsRepository,
    'get' | 'update' | 'updateProvider'
  >;
  readonly #descriptors: ReadonlyMap<string, AiProviderDescriptor>;

  public constructor(
    database: JournalDatabase,
    descriptors: readonly AiProviderDescriptor[],
    private readonly backupConfigured: boolean,
    private readonly credentialCipher?: ProviderCredentialCipher,
    private readonly synchronizeBackupSchedule?: (
      enabled: boolean,
    ) => Promise<void>,
    private readonly now: () => Date = () => new Date(),
    repository?: Pick<SettingsRepository, 'get' | 'update' | 'updateProvider'>,
  ) {
    this.#repository = repository ?? new SettingsRepository(database);
    this.#descriptors = new Map(
      descriptors.map((descriptor) => [descriptor.id, descriptor]),
    );
  }

  public async get(ownerId: string): Promise<SettingsResource> {
    const persisted = await this.#repository.get(ownerId);
    return {
      revision: persisted.revision,
      journalTimezone: persisted.journalTimezone,
      retention: persisted.retention,
      backup: {
        configured: this.backupConfigured,
        scheduleEnabled:
          this.backupConfigured && persisted.backupScheduleEnabled,
        schedule: '03:30 UTC daily',
        encrypted: true,
        retentionSummary: '7 daily, 5 weekly, and 12 monthly snapshots',
      },
      privacy: {
        journalPrivateByDefault: true,
        contentFreeLogs: true,
        credentialsExcludedFromExports: true,
        externalProcessingRequiresProviderEnablement: true,
        offlineCacheEncrypted: true,
      },
      providers: [...this.#descriptors.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((descriptor) => {
          const configuration = persisted.providers.find(
            (item) => item.providerId === descriptor.id,
          );
          const disclosureVersion = providerDisclosureVersion(descriptor);
          const disclosureAccepted =
            configuration?.disclosureVersion === disclosureVersion;
          return {
            id: descriptor.id,
            displayName: descriptor.displayName,
            capabilities: [...descriptor.capabilities],
            disclosure: descriptor.disclosure,
            disclosureVersion,
            enabled: configuration?.enabled === true && disclosureAccepted,
            models: this.#validModels(
              descriptor,
              configuration?.models ?? {},
              false,
            ),
            credentialConfigured: persisted.credentialProviderIds.includes(
              descriptor.id,
            ),
            credentialStorageAvailable: this.credentialCipher !== undefined,
            ...(disclosureAccepted && configuration?.disclosureAcceptedAt
              ? {
                  disclosureAcceptedAt:
                    configuration.disclosureAcceptedAt.toISOString(),
                }
              : {}),
            revision: configuration?.revision ?? 1,
          };
        }),
    };
  }

  public async update(
    ownerId: string,
    expectedRevision: number,
    request: UpdateSettingsRequest,
    idempotencyKey: string,
    correlationId: string,
  ) {
    try {
      parseIanaTimezone(request.journalTimezone);
    } catch {
      throw new SettingsValidationError(
        'Journal timezone must be a valid IANA timezone.',
      );
    }
    if (request.backupScheduleEnabled && !this.backupConfigured)
      throw new SettingsValidationError(
        'Configure the encrypted backup repository before enabling its schedule.',
      );
    const result = await this.#repository.update({
      ownerId,
      expectedRevision,
      request,
      idempotencyKey,
      requestHash: settingsRequestHash(request),
      correlationId,
      now: this.now(),
    });
    await this.synchronizeBackupSchedule?.(request.backupScheduleEnabled);
    return { settings: await this.get(ownerId), replayed: result.replayed };
  }

  public async updateProvider(
    ownerId: string,
    providerId: string,
    expectedRevision: number,
    request: UpdateProviderSettingsRequest,
    idempotencyKey: string,
    correlationId: string,
  ) {
    const descriptor = this.#descriptors.get(providerId);
    if (descriptor === undefined)
      throw new SettingsValidationError(
        'The provider adapter is not registered.',
      );
    const models = this.#validModels(descriptor, request.models);
    const disclosureVersion = providerDisclosureVersion(descriptor);
    const current = (await this.get(ownerId)).providers.find(
      (item) => item.id === providerId,
    );
    const disclosureAlreadyAccepted =
      current?.disclosureAcceptedAt !== undefined &&
      current.disclosureVersion === disclosureVersion;
    const acknowledgementMatches =
      request.acknowledgeDisclosureVersion === disclosureVersion;
    if (
      request.enabled &&
      !disclosureAlreadyAccepted &&
      !acknowledgementMatches
    )
      throw new SettingsValidationError(
        'Accept the current provider disclosure before enabling external processing.',
      );
    const credential = request.credential;
    if (credential !== undefined && this.credentialCipher === undefined)
      throw new SettingsValidationError(
        'Provider credential storage is unavailable until an encryption key is configured.',
      );
    const requestFingerprint = {
      ...request,
      models,
      ...(credential === undefined
        ? {}
        : {
            credential: this.credentialCipher?.fingerprint(credential),
          }),
    };
    const secretFreeRequest: UpdateProviderSettingsRequest = {
      enabled: request.enabled,
      models,
      ...(request.acknowledgeDisclosureVersion === undefined
        ? {}
        : {
            acknowledgeDisclosureVersion: request.acknowledgeDisclosureVersion,
          }),
      ...(request.clearCredential === undefined
        ? {}
        : { clearCredential: request.clearCredential }),
    };
    const result = await this.#repository.updateProvider({
      ownerId,
      providerId,
      expectedRevision,
      request: secretFreeRequest,
      idempotencyKey,
      requestHash: settingsRequestHash(requestFingerprint),
      ...(acknowledgementMatches ? { disclosureVersion } : {}),
      ...(credential === undefined || this.credentialCipher === undefined
        ? {}
        : {
            credential: this.credentialCipher.encrypt(
              ownerId,
              providerId,
              credential,
            ),
          }),
      correlationId,
      now: this.now(),
    });
    const provider = (await this.get(ownerId)).providers.find(
      (item) => item.id === providerId,
    );
    if (provider === undefined)
      throw new SettingsValidationError('Provider settings are unavailable.');
    return { provider, replayed: result.replayed };
  }

  #validModels(
    descriptor: AiProviderDescriptor,
    models: Readonly<Partial<Record<ProviderCapability, string>>>,
    rejectUnsupported = true,
  ): Partial<Record<ProviderCapability, string>> {
    for (const capability of Object.keys(models) as ProviderCapability[]) {
      if (rejectUnsupported && !descriptor.capabilities.includes(capability))
        throw new SettingsValidationError(
          `The provider does not support ${capability.replaceAll('_', ' ')}.`,
        );
    }
    return Object.fromEntries(
      Object.entries(models).filter(
        ([capability, value]) =>
          value !== undefined &&
          descriptor.capabilities.includes(capability as ProviderCapability),
      ),
    ) as Partial<Record<ProviderCapability, string>>;
  }
}
