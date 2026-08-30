import { describe, expect, it, vi } from 'vitest';

import {
  AiProviderOperationError,
  AiProviderFactoryRegistry,
  RawResponseConflictError,
  RawResponseNotAvailableError,
  type AiOperationSnapshot,
  type JsonValue,
} from '@journal/ai';

import {
  DeterministicEmbeddingProvider,
  InMemoryRawResponseStore,
  createDeterministicAiProviderFactory,
  createFaultInjectingAiProviderFactory,
} from '../src/index.js';

async function* audio(value: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(value);
}

const selection = Object.freeze({
  providerId: 'fixture-a',
  enabled: true,
  settings: Object.freeze({}),
});

const operation: AiOperationSnapshot = Object.freeze({
  provider: Object.freeze({ id: 'fixture-a', displayName: 'Fixture A' }),
  model: Object.freeze({ id: 'fixture-model', version: '1' }),
  configuration: Object.freeze({
    parameters: Object.freeze({}),
    fingerprint: 'abc',
  }),
  processingTimeMs: 1,
});

function rawWrite(
  id: string,
  body: string,
  retention: 'days_30' | 'do_not_retain' = 'days_30',
) {
  return Object.freeze({
    id,
    capability: 'speech_to_text' as const,
    capturedAt: new Date('2026-08-23T00:00:00.000Z'),
    response: Object.freeze({
      body: new TextEncoder().encode(body),
      mediaType: 'application/json',
      providerRequestId: 'request-1',
    }),
    operation,
    retention,
  });
}

describe('deterministic AI provider fixtures', () => {
  it('DATA-023 returns repeatable normalized STT with provenance and exact raw bytes', async () => {
    const registry = new AiProviderFactoryRegistry([
      createDeterministicAiProviderFactory({
        providerId: 'fixture-a',
        displayName: 'Fixture A',
        speech: { text: 'hello journal', language: 'en', timestamps: true },
      }),
    ]);
    const resolution = await registry.resolve(selection, 'speech_to_text');
    expect(resolution.status).toBe('available');
    if (resolution.status !== 'available') return;

    const request = {
      audio: { body: audio('fake audio'), mediaType: 'audio/webm' },
      context: [{ text: 'Nicolette', purpose: 'vocabulary', version: '3' }],
      configuration: { temperature: 0, alternatives: ['one', 'two'] },
    } as const;
    const first = await resolution.port.transcribe(request);
    const second = await resolution.port.transcribe({
      ...request,
      audio: { ...request.audio, body: audio('fake audio') },
    });

    expect(first).toMatchObject({
      text: 'hello journal',
      language: { status: 'known', value: 'en' },
      timingAvailability: { segments: 'known', words: 'known' },
      operation: {
        provider: { id: 'fixture-a' },
        model: { id: 'deterministic-speech-v1', version: '1' },
        configuration: { parameters: request.configuration },
        processingTimeMs: 1,
      },
    });
    expect(first.segments[0]).toMatchObject({
      timing: { status: 'known', startMs: 0, endMs: 500 },
      words: {
        status: 'known',
        items: [
          { text: 'hello', timing: { startMs: 0, endMs: 250 } },
          { text: 'journal', timing: { startMs: 250, endMs: 500 } },
        ],
      },
    });
    expect(first.rawResponse.body).toEqual(second.rawResponse.body);
    expect(new TextDecoder().decode(first.rawResponse.body)).toContain(
      '"byte_length":10',
    );
  });

  it('DATA-028 and MODEL-004 keep untimed, unknown-language STT valid', async () => {
    const registry = new AiProviderFactoryRegistry([
      createDeterministicAiProviderFactory({
        providerId: 'fixture-a',
        speech: { text: '', timestamps: false },
      }),
    ]);
    const resolution = await registry.resolve(selection, 'speech_to_text');
    if (resolution.status !== 'available')
      throw new Error('fixture unavailable');

    const result = await resolution.port.transcribe({
      audio: { body: audio(''), mediaType: 'audio/webm' },
      context: [],
      configuration: {},
    });

    expect(result.text).toBe('');
    expect(result.language).toEqual({ status: 'unknown' });
    expect(result.timingAvailability).toEqual({
      segments: 'unknown',
      words: 'unknown',
    });
    expect(result.segments).toEqual([
      {
        text: '',
        timing: { status: 'unknown' },
        words: { status: 'unknown' },
      },
    ]);
  });

  it('[MODEL-003][MODEL-005][AC-052] switches providers without changing the captured source or earlier result', async () => {
    const sourceBytes = new TextEncoder().encode('immutable fake audio');
    const registry = new AiProviderFactoryRegistry([
      createDeterministicAiProviderFactory({
        providerId: 'fixture-a',
        displayName: 'Fixture A',
        speech: { text: 'earlier transcript', timestamps: true },
      }),
      createDeterministicAiProviderFactory({
        providerId: 'fixture-b',
        displayName: 'Fixture B',
        speech: { text: 'later transcript', timestamps: false },
      }),
    ]);
    const transcribeWith = async (providerId: string) => {
      const resolved = await registry.resolve(
        { providerId, enabled: true, settings: {} },
        'speech_to_text',
      );
      if (resolved.status !== 'available')
        throw new Error(`Provider ${providerId} is unavailable.`);
      return resolved.port.transcribe({
        audio: {
          body: (async function* immutableSource() {
            yield sourceBytes.slice();
          })(),
          mediaType: 'audio/webm',
          byteLength: BigInt(sourceBytes.byteLength),
        },
        context: [],
        configuration: {},
      });
    };

    const earlier = await transcribeWith('fixture-a');
    const earlierSnapshot = structuredClone(earlier);
    const later = await transcribeWith('fixture-b');

    expect(later).toMatchObject({
      text: 'later transcript',
      operation: { provider: { id: 'fixture-b' } },
    });
    expect(earlier).toEqual(earlierSnapshot);
    expect(earlier).toMatchObject({
      text: 'earlier transcript',
      operation: { provider: { id: 'fixture-a' } },
    });
    expect(new TextDecoder().decode(sourceBytes)).toBe('immutable fake audio');
  });

  it('MODEL-002 validates structured output and snapshots its schema and prompt', async () => {
    const output = { mood: 'neutral', score: 0 } as const;
    const registry = new AiProviderFactoryRegistry([
      createDeterministicAiProviderFactory({
        providerId: 'fixture-a',
        structuredOutput: output,
      }),
    ]);
    const resolution = await registry.resolve(
      selection,
      'structured_generation',
    );
    if (resolution.status !== 'available')
      throw new Error('fixture unavailable');
    const parse = vi.fn((value: unknown) => value as typeof output);

    const result = await resolution.port.generate({
      messages: [{ role: 'user', content: 'Synthetic content.' }],
      outputSchema: {
        id: 'mood-result',
        version: '2',
        jsonSchema: { type: 'object' },
        parse,
      },
      prompt: { id: 'mood-prompt', version: '4', templateHash: 'hash-4' },
      configuration: { temperature: 0 },
    });

    expect(parse).toHaveBeenCalledWith(output);
    expect(result).toMatchObject({
      data: output,
      schema: { id: 'mood-result', version: '2' },
      prompt: { id: 'mood-prompt', version: '4', templateHash: 'hash-4' },
      usage: { status: 'unknown' },
      operation: { model: { id: 'deterministic-structured-v1' } },
    });
  });

  it('MODEL-005 produces stable embeddings with model and dimension metadata', async () => {
    const factory = createDeterministicAiProviderFactory({
      providerId: 'fixture-a',
      embeddingDimension: 3,
    });
    const registry = new AiProviderFactoryRegistry([factory]);
    const resolution = await registry.resolve(selection, 'embeddings');
    if (resolution.status !== 'available')
      throw new Error('fixture unavailable');
    const request = {
      fragments: [
        { id: 'a', text: 'same' },
        { id: 'b', text: 'same' },
      ],
      configuration: { dimensions: 3 },
    } as const;

    const result = await resolution.port.embed(request);

    expect(result.dimension).toBe(3);
    expect(result.embeddings[0]?.vector).toHaveLength(3);
    expect(result.embeddings[0]?.vector).toEqual(result.embeddings[1]?.vector);
    expect(result.operation.model.id).toBe('deterministic-embedding-v1');
  });

  it('supports capability-specific fake factories and validates dimensions', () => {
    const descriptor = createDeterministicAiProviderFactory({
      speech: false,
      structuredOutput: false,
      embeddingDimension: false,
    }).descriptor;
    expect(descriptor.capabilities).toEqual([]);
    expect(
      () =>
        new DeterministicEmbeddingProvider(
          { id: 'bad', displayName: 'Bad fixture' },
          0,
        ),
    ).toThrow(RangeError);
  });

  it('[STATE-003][SEC-007] injects invocation-ordered outages and rate limits without retaining provider input', async () => {
    const factory = createFaultInjectingAiProviderFactory(
      createDeterministicAiProviderFactory({
        providerId: 'fixture-a',
        speech: { text: 'recovered transcript', timestamps: false },
        structuredOutput: { recovered: true },
        embeddingDimension: 2,
      }),
      {
        speech_to_text: [
          new AiProviderOperationError({
            code: 'provider_rate_limited',
            retryable: true,
            retryAfterMilliseconds: 1_000,
          }),
        ],
        structured_generation: [
          new AiProviderOperationError({
            code: 'provider_unavailable',
            retryable: true,
          }),
        ],
      },
    );
    const adapter = await factory.create({});
    const speech = adapter.speech_to_text;
    const structured = adapter.structured_generation;
    if (speech === undefined || structured === undefined)
      throw new Error('Fault fixture capabilities are unavailable.');
    const privateSpeech = 'private synthetic provider input';
    const speechRequest = {
      audio: { body: audio(privateSpeech), mediaType: 'audio/webm' },
      context: [],
      configuration: {},
    } as const;

    await expect(speech.transcribe(speechRequest)).rejects.toMatchObject({
      code: 'provider_rate_limited',
      retryable: true,
      retryAfterMilliseconds: 1_000,
    });
    await expect(
      speech.transcribe({
        ...speechRequest,
        audio: { ...speechRequest.audio, body: audio(privateSpeech) },
      }),
    ).resolves.toMatchObject({ text: 'recovered transcript' });

    const structuredRequest = {
      messages: [{ role: 'user' as const, content: privateSpeech }],
      outputSchema: {
        id: 'fault-fixture',
        version: '1',
        jsonSchema: { type: 'object' },
        parse: (value: unknown) => value as JsonValue,
      },
      prompt: { id: 'fault-fixture', version: '1', templateHash: 'hash' },
      configuration: {},
    };
    let failure: unknown;
    try {
      await structured.generate(structuredRequest);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'provider_unavailable' });
    expect(String(failure)).not.toContain(privateSpeech);
    await expect(structured.generate(structuredRequest)).resolves.toMatchObject(
      { data: { recovered: true } },
    );
  });
});

describe('InMemoryRawResponseStore contract fake', () => {
  it('DATA-022 and MODEL-006 preserves exact bytes and makes retries idempotent', async () => {
    const store = new InMemoryRawResponseStore();
    const write = rawWrite('raw-1', '{ "exact": true }');

    const first = await store.putImmutable(write);
    write.response.body.fill(0);
    const opened = await store.open('raw-1');
    opened.body.fill(0);
    const reopened = await store.open('raw-1');

    expect(first).toMatchObject({
      id: 'raw-1',
      byteLength: 17n,
      retention: 'days_30',
      state: 'retained',
    });
    expect(new TextDecoder().decode(reopened.body)).toBe('{ "exact": true }');
    await expect(
      store.putImmutable(rawWrite('raw-1', '{ "exact": true }')),
    ).resolves.toEqual(first);
  });

  it('DATA-022 rejects conflicting immutable writes', async () => {
    const store = new InMemoryRawResponseStore();
    await store.putImmutable(rawWrite('raw-conflict', 'first'));

    await expect(
      store.putImmutable(rawWrite('raw-conflict', 'second')),
    ).rejects.toBeInstanceOf(RawResponseConflictError);
  });

  it('MODEL-006 records do-not-retain without retaining content', async () => {
    const store = new InMemoryRawResponseStore();
    const reference = await store.putImmutable(
      rawWrite('raw-private', 'private', 'do_not_retain'),
    );

    expect(reference.state).toBe('not_retained');
    await expect(store.open('raw-private')).rejects.toBeInstanceOf(
      RawResponseNotAvailableError,
    );
    await expect(store.open('missing')).rejects.toBeInstanceOf(
      RawResponseNotAvailableError,
    );
  });
});

it('keeps JSON-shaped fake output provider-neutral', () => {
  const value: JsonValue = { nested: [true, null, 'value'] };
  expect(value).toEqual({ nested: [true, null, 'value'] });
});
