import { describe, expect, it, vi } from 'vitest';
import {
  AiProviderFactoryRegistry,
  AiProviderOperationError,
  createOpenAiProviderFactory,
  createProviderCredentialCipher,
  openAiDescriptor,
  providerDisclosureVersion,
  type StructuredGenerationRequest,
  type SpeechToTextRequest,
} from '../src/index.js';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected value');
  return value;
}

const textRequest: StructuredGenerationRequest<{ answer: string }> = {
  messages: [
    { role: 'system', content: 'Return JSON.' },
    { role: 'user', content: 'private journal' },
  ],
  prompt: { id: 'prompt', version: '1', templateHash: 'hash' },
  outputSchema: {
    id: 'a.schema/with spaces',
    version: '1',
    jsonSchema: {
      type: 'object',
      properties: { answer: { type: 'string' }, optional: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    },
    parse(value) {
      if (
        !value ||
        typeof value !== 'object' ||
        !('answer' in value) ||
        typeof value.answer !== 'string'
      )
        throw new Error('private invalid output');
      return { answer: value.answer };
    },
  },
  configuration: {
    temperature: 0,
    apiKey: 'must-not-leak',
    unknown: 'private',
  },
};
const textResponse = {
  model: 'test-model-snapshot',
  status: 'completed',
  output: [
    {
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: '{"answer":"yes"}' }],
    },
  ],
  usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
};
function setup(response: unknown = textResponse, init: ResponseInit = {}) {
  const raw =
    typeof response === 'string' ? response : JSON.stringify(response, null, 2);
  const fetcher = vi.fn<typeof fetch>().mockImplementation(
    async () =>
      new Response(raw, {
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req_123',
        },
        ...init,
      }),
  );
  const factory = createOpenAiProviderFactory({ fetch: fetcher });
  return {
    fetcher,
    factory,
    raw,
    adapter: factory.create({
      apiKey: 'secret-api-key',
      models: {
        structured_generation: 'test-model',
        speech_to_text: 'whisper-1',
      },
    }),
  };
}
function audioRequest(
  extra: Partial<SpeechToTextRequest> = {},
): SpeechToTextRequest {
  return {
    audio: {
      body: (async function* () {
        yield new Uint8Array([1, 2, 3]);
      })(),
      mediaType: 'audio/webm;codecs=opus',
      byteLength: 3n,
    },
    context: [{ text: 'Alice', purpose: 'vocabulary', version: '1' }],
    configuration: {},
    ...extra,
  };
}

describe('OpenAI structured generation', () => {
  it('requests non-strict schemas, validates output, preserves raw bytes, and sanitizes snapshots', async () => {
    const { adapter, fetcher, raw } = setup();
    const result = await required(
      (await adapter).structured_generation,
    ).generate(textRequest);
    expect(result.data).toEqual({ answer: 'yes' });
    expect(result.effectiveMessages).toEqual(textRequest.messages);
    expect(result.prompt).toEqual(textRequest.prompt);
    expect(result.schema).toEqual({
      id: textRequest.outputSchema.id,
      version: '1',
    });
    expect(result.usage).toEqual({
      status: 'known',
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
    });
    expect(result.operation.model).toEqual({
      id: 'test-model',
      version: 'test-model-snapshot',
    });
    expect(new TextDecoder().decode(result.rawResponse.body)).toBe(raw);
    expect(result.rawResponse.providerRequestId).toBe('req_123');
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: 'test-model',
      store: false,
      temperature: 0,
      input: textRequest.messages,
      text: {
        format: {
          type: 'json_schema',
          strict: false,
          schema: textRequest.outputSchema.jsonSchema,
        },
      },
    });
    expect(body.text.format.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(JSON.stringify(result.operation)).not.toMatch(
      /must-not-leak|secret-api-key|private/,
    );
    expect(JSON.stringify(body)).not.toMatch(
      /must-not-leak|secret-api-key|unknown/,
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://api.openai.com/v1/responses',
    );
  });
  it.each([
    'not JSON',
    { ...textResponse, status: 'incomplete' },
    { ...textResponse, output: [] },
    {
      ...textResponse,
      output: [
        {
          type: 'message',
          status: 'completed',
          content: [{ type: 'refusal', refusal: 'private reason' }],
        },
      ],
    },
    {
      ...textResponse,
      output: [
        {
          type: 'message',
          status: 'completed',
          content: [{ type: 'output_text', text: '{"answer":12}' }],
        },
      ],
    },
  ])(
    'rejects malformed, incomplete, refused, or schema-invalid output',
    async (response) => {
      const { adapter } = setup(response);
      await expect(
        required((await adapter).structured_generation).generate(textRequest),
      ).rejects.toMatchObject({
        code: 'provider_invalid_request',
        retryable: false,
        message: 'AI provider operation failed.',
      });
    },
  );
  it('reports missing token usage as unknown', async () => {
    const { adapter } = setup({ ...textResponse, usage: null });
    expect(
      (
        await required((await adapter).structured_generation).generate(
          textRequest,
        )
      ).usage,
    ).toEqual({ status: 'unknown' });
  });
});

describe('OpenAI transcription', () => {
  it('normalizes Whisper timestamps and preserves context and raw bytes', async () => {
    const { adapter, fetcher, raw } = setup({
      text: 'Hello world',
      language: 'english',
      segments: [{ text: 'Hello world', start: 0.1, end: 1.4 }],
      words: [
        { word: 'Hello', start: 0.1, end: 0.6 },
        { word: 'world', start: 0.7, end: 1.4 },
      ],
    });
    const request = audioRequest();
    const result = await required((await adapter).speech_to_text).transcribe(
      request,
    );
    expect(result.segments[0]).toMatchObject({
      timing: { status: 'known', startMs: 100, endMs: 1400 },
      words: {
        status: 'known',
        items: [
          {
            text: 'Hello',
            timing: { status: 'known', startMs: 100, endMs: 600 },
            confidence: { status: 'unknown' },
          },
          { text: 'world' },
        ],
      },
    });
    expect(result.timingAvailability).toEqual({
      segments: 'known',
      words: 'known',
    });
    expect(result.language).toEqual({ status: 'known', value: 'english' });
    expect(result.effectiveContext).toEqual(request.context);
    expect(new TextDecoder().decode(result.rawResponse.body)).toBe(raw);
    const form = fetcher.mock.calls[0]?.[1]?.body as FormData;
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.getAll('timestamp_granularities[]')).toEqual([
      'segment',
      'word',
    ]);
    expect(form.get('prompt')).toBe('Alice');
    const file = form.get('file') as File;
    expect(file.name).toBe('recording.webm');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(JSON.stringify(result.operation)).not.toContain('Alice');
  });
  it.each(['gpt-transcribe', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'])(
    'uses JSON and unknown metadata for %s',
    async (model) => {
      const { factory, fetcher } = setup({ text: 'Hello' });
      const adapter = await factory.create({
        apiKey: 'key',
        models: { speech_to_text: model },
      });
      const result = await required(adapter.speech_to_text).transcribe(
        audioRequest(),
      );
      expect(result.language).toEqual({ status: 'unknown' });
      expect(result.segments).toEqual([
        {
          text: 'Hello',
          timing: { status: 'unknown' },
          words: { status: 'unknown' },
        },
      ]);
      expect(result.timingAvailability).toEqual({
        segments: 'unknown',
        words: 'unknown',
      });
      const form = fetcher.mock.calls[0]?.[1]?.body as FormData;
      expect(form.get('response_format')).toBe('json');
      expect(form.has('timestamp_granularities[]')).toBe(false);
    },
  );
  it('consumes the stream once and propagates source failures without making an HTTP request', async () => {
    const { adapter, fetcher } = setup();
    const failure = new Error('source failure');
    const body = {
      [Symbol.asyncIterator]: vi.fn(async function* () {
        yield new Uint8Array([1]);
        throw failure;
      }),
    };
    await expect(
      required((await adapter).speech_to_text).transcribe(
        audioRequest({ audio: { body, mediaType: 'audio/webm' } }),
      ),
    ).rejects.toBe(failure);
    expect(body[Symbol.asyncIterator]).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    'known size',
    'stream size',
    'media type',
    'size mismatch',
    'empty',
  ])('rejects invalid audio: %s', async (kind) => {
    const { adapter, fetcher } = setup();
    const request = audioRequest();
    const audio = {
      ...request.audio,
      ...(kind === 'known size'
        ? { byteLength: 25_000_001n }
        : kind === 'stream size'
          ? {
              body: (async function* () {
                yield new Uint8Array(25_000_001);
              })(),
            }
          : kind === 'media type'
            ? { mediaType: 'audio/ogg' }
            : kind === 'size mismatch'
              ? { byteLength: 4n }
              : { body: (async function* () {})() }),
    };
    await expect(
      required((await adapter).speech_to_text).transcribe({
        ...request,
        audio,
      }),
    ).rejects.toMatchObject({ code: 'provider_invalid_request' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('provider failures and cancellation', () => {
  it.each([
    [400, 'provider_invalid_request', false],
    [401, 'provider_authentication_failed', false],
    [403, 'provider_authentication_failed', false],
    [408, 'provider_timeout', true],
    [429, 'provider_rate_limited', true],
    [503, 'provider_unavailable', true],
  ])(
    'classifies HTTP %i without leaking bodies',
    async (status, code, retryable) => {
      const { adapter } = setup('private error with secret-api-key', {
        status: status as number,
        headers: { 'retry-after': '2' },
      });
      await expect(
        required((await adapter).structured_generation).generate(textRequest),
      ).rejects.toMatchObject({
        code,
        retryable,
        retryAfterMilliseconds: 2000,
        message: 'AI provider operation failed.',
      });
    },
  );
  it('sanitizes network failures', async () => {
    const factory = createOpenAiProviderFactory({
      fetch: vi.fn().mockRejectedValue(new Error('secret-api-key')),
    });
    const adapter = await factory.create({
      apiKey: 'key',
      models: { structured_generation: 'test' },
    });
    await expect(
      required(adapter.structured_generation).generate(textRequest),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      message: 'AI provider operation failed.',
    });
  });
  it('cancels requests and passes the signal to the transport', async () => {
    const controller = new AbortController();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        controller.abort();
        expect(init?.signal?.aborted).toBe(true);
        return new Promise(() => {});
      });
    const adapter = await createOpenAiProviderFactory({
      fetch: fetcher,
    }).create({ apiKey: 'key', models: { structured_generation: 'test' } });
    await expect(
      required(adapter.structured_generation).generate({
        ...textRequest,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('cancels a stalled audio stream', async () => {
    const controller = new AbortController();
    const { adapter, fetcher } = setup();
    const body = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            controller.abort();
            return new Promise<IteratorResult<Uint8Array>>(() => {});
          },
        };
      },
    };
    await expect(
      required((await adapter).speech_to_text).transcribe(
        audioRequest({
          signal: controller.signal,
          audio: { body, mediaType: 'audio/webm' },
        }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('times out a stalled request', async () => {
    const adapter = await createOpenAiProviderFactory({
      fetch: vi.fn().mockImplementation(() => new Promise(() => {})),
      timeoutMilliseconds: 5,
    }).create({ apiKey: 'key', models: { structured_generation: 'test' } });
    await expect(
      required(adapter.structured_generation).generate(textRequest),
    ).rejects.toMatchObject({ code: 'provider_timeout', retryable: true });
  });
  it('registers only implemented capabilities', async () => {
    const registry = new AiProviderFactoryRegistry([
      createOpenAiProviderFactory(),
    ]);
    expect(registry.listProviders()).toEqual([openAiDescriptor]);
    expect(
      await registry.resolve(
        {
          providerId: 'openai',
          enabled: true,
          settings: { apiKey: 'key', models: {} },
        },
        'embeddings',
      ),
    ).toMatchObject({
      status: 'unavailable',
      reason: 'capability_not_supported',
    });
  });
});

describe('server credential boundary', () => {
  const key = Buffer.alloc(32, 7).toString('base64url');
  it('round trips existing version 1 format and binds owner/provider', () => {
    const cipher = createProviderCredentialCipher(key);
    const encrypted = cipher.encrypt('owner', 'openai', 'secret');
    expect(cipher.decrypt('owner', 'openai', encrypted)).toBe('secret');
    expect(encrypted).not.toEqual(cipher.encrypt('owner', 'openai', 'secret'));
    for (const action of [
      () => cipher.decrypt('other', 'openai', encrypted),
      () => cipher.decrypt('owner', 'other', encrypted),
      () =>
        cipher.decrypt('owner', 'openai', {
          ...encrypted,
          encryptionVersion: 2,
        }),
      () =>
        cipher.decrypt('owner', 'openai', {
          ...encrypted,
          ciphertext: Buffer.alloc(32).toString('base64url'),
        }),
      () =>
        createProviderCredentialCipher(
          Buffer.alloc(32, 8).toString('base64url'),
        ).decrypt('owner', 'openai', encrypted),
    ])
      expect(action).toThrow(AiProviderOperationError);
    expect(providerDisclosureVersion(openAiDescriptor)).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });
});
