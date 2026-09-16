import { describe, expect, it, vi } from 'vitest';
import {
  AiProviderFactoryRegistry,
  createOpenAiProviderFactory,
  createProviderCredentialCipher,
  openAiDescriptor,
  providerDisclosureVersion,
} from '@journal/ai';
import type { ProviderExecutionRepository } from '@journal/database';
import { OwnerProviderResolver } from '../src/provider-resolver.js';

function setup() {
  const cipher = createProviderCredentialCipher(
    Buffer.alloc(32, 3).toString('base64url'),
  );
  const now = new Date();
  const row = {
    configuration: {
      ownerId: 'owner',
      providerId: 'openai',
      enabled: true,
      models: {
        structured_generation: 'test-model',
        speech_to_text: 'whisper-1',
      } as Record<string, string>,
      disclosureVersion: providerDisclosureVersion(openAiDescriptor),
      disclosureAcceptedAt: now as Date | null,
      revision: 1,
      updatedAt: now,
    },
    credential: {
      ownerId: 'owner',
      providerId: 'openai',
      ...cipher.encrypt('owner', 'openai', 'private-key'),
      createdAt: now,
      updatedAt: now,
    },
  };
  const repository = {
    get: vi.fn<ProviderExecutionRepository['get']>().mockResolvedValue(row),
    recordingOwner: vi
      .fn<ProviderExecutionRepository['recordingOwner']>()
      .mockResolvedValue('owner'),
    journalDayOwner: vi
      .fn<ProviderExecutionRepository['journalDayOwner']>()
      .mockResolvedValue('owner'),
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ text: 'transcribed' })));
  const registry = new AiProviderFactoryRegistry([
    createOpenAiProviderFactory({ fetch: fetcher }),
  ]);
  return {
    cipher,
    row,
    repository,
    fetcher,
    registry,
    resolver: new OwnerProviderResolver(repository, registry, cipher),
  };
}

describe('owner-scoped production provider resolution', () => {
  it('loads the canonical recording owner and uses only their configured credential and model', async () => {
    const { resolver, repository, fetcher } = setup();
    const result = await resolver.forRecording(
      'recording',
      { apiKey: 'attacker', model: 'wrong' },
      'speech_to_text',
    );
    expect(repository.recordingOwner).toHaveBeenCalledWith('recording');
    expect(repository.get).toHaveBeenCalledWith('owner', 'openai');
    if (result.status !== 'available') throw new Error('Expected provider');
    const transcript = await result.port.transcribe({
      audio: {
        body: (async function* () {
          yield new Uint8Array([1]);
        })(),
        mediaType: 'audio/webm',
      },
      configuration: {},
      context: [],
    });
    expect(transcript.text).toBe('transcribed');
    expect(transcript.operation.model.id).toBe('whisper-1');
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer private-key',
    });
  });
  it('resolves processor owners from their journal day', async () => {
    const { resolver, repository } = setup();
    expect(
      await resolver.forJournalDay('day', {}, 'structured_generation'),
    ).toMatchObject({ status: 'available' });
    expect(repository.journalDayOwner).toHaveBeenCalledWith('day');
  });
  it.each([
    'disabled',
    'stale disclosure',
    'unaccepted disclosure',
    'missing configuration',
  ])('does not execute for %s', async (kind) => {
    const { resolver, repository, row, cipher, fetcher } = setup();
    const decrypt = vi.spyOn(cipher, 'decrypt');
    if (kind === 'disabled') row.configuration.enabled = false;
    if (kind === 'stale disclosure')
      row.configuration.disclosureVersion = 'old';
    if (kind === 'unaccepted disclosure')
      row.configuration.disclosureAcceptedAt = null;
    if (kind === 'missing configuration')
      repository.get.mockResolvedValue(undefined);
    expect(
      await resolver.resolve('owner', {}, 'structured_generation'),
    ).toMatchObject({ status: 'unavailable', reason: 'provider_disabled' });
    expect(decrypt).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects missing models, missing credentials, unavailable encryption, and wrong owners', async () => {
    const { resolver, repository, row, registry } = setup();
    delete row.configuration.models.structured_generation;
    await expect(
      resolver.resolve('owner', {}, 'structured_generation'),
    ).rejects.toMatchObject({ code: 'provider_invalid_request' });
    row.configuration.models.structured_generation = 'test-model';
    await expect(
      resolver.resolve('other-owner', {}, 'structured_generation'),
    ).rejects.toMatchObject({ code: 'provider_authentication_failed' });
    await expect(
      new OwnerProviderResolver(repository, registry).resolve(
        'owner',
        {},
        'structured_generation',
      ),
    ).rejects.toMatchObject({ code: 'provider_authentication_failed' });
    repository.get.mockResolvedValue({ ...row, credential: null });
    await expect(
      resolver.resolve('owner', {}, 'structured_generation'),
    ).rejects.toMatchObject({ code: 'provider_authentication_failed' });
  });
  it('honors disabling and credential removal between operations', async () => {
    const { resolver, repository, row } = setup();
    expect(
      await resolver.resolve('owner', {}, 'structured_generation'),
    ).toMatchObject({ status: 'available' });
    repository.get.mockResolvedValue({ ...row, credential: null });
    await expect(
      resolver.resolve('owner', {}, 'structured_generation'),
    ).rejects.toMatchObject({ code: 'provider_authentication_failed' });
  });
  it('rejects unknown providers and unsupported capabilities without accessing credentials', async () => {
    const { resolver, repository } = setup();
    expect(
      await resolver.resolve(
        'owner',
        { providerId: 'other' },
        'structured_generation',
      ),
    ).toMatchObject({ reason: 'provider_not_registered' });
    expect(await resolver.resolve('owner', {}, 'embeddings')).toMatchObject({
      reason: 'capability_not_supported',
    });
    expect(repository.get).not.toHaveBeenCalled();
  });
});
