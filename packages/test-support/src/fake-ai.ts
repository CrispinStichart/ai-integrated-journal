import { createHash } from 'node:crypto';

import {
  RawResponseConflictError,
  RawResponseNotAvailableError,
  type AiOperationSnapshot,
  type AiProviderAdapter,
  type AiProviderDescriptor,
  type AiProviderFactory,
  type EmbeddingProvider,
  type EmbeddingRequest,
  type EmbeddingResult,
  type JsonObject,
  type JsonValue,
  type NormalizedTranscriptSegment,
  type RawProviderResponse,
  type RawResponseReference,
  type RawResponseStore,
  type RawResponseWrite,
  type SpeechToTextProvider,
  type SpeechToTextRequest,
  type SpeechToTextResult,
  type StructuredGenerationProvider,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
} from '@journal/ai';

const encoder = new TextEncoder();

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function operation(
  provider: Readonly<{ id: string; displayName: string }>,
  modelId: string,
  configuration: JsonObject,
): AiOperationSnapshot {
  return Object.freeze({
    provider: Object.freeze({ ...provider, adapterVersion: 'fake-v1' }),
    model: Object.freeze({ id: modelId, version: '1' }),
    configuration: Object.freeze({
      parameters: configuration,
      fingerprint: sha256(canonicalJson(configuration)),
    }),
    processingTimeMs: 1,
  });
}

function rawResponse(value: JsonValue): RawProviderResponse {
  return Object.freeze({
    body: encoder.encode(canonicalJson(value)),
    mediaType: 'application/json',
    providerRequestId: `fake-${sha256(canonicalJson(value)).slice(0, 12)}`,
  });
}

async function consumeAudio(body: AsyncIterable<Uint8Array>): Promise<number> {
  let byteLength = 0;
  for await (const bytes of body) byteLength += bytes.byteLength;
  return byteLength;
}

export type DeterministicSpeechFixture = Readonly<{
  text: string;
  language?: string;
  timestamps?: boolean;
}>;

export class DeterministicSpeechToTextProvider implements SpeechToTextProvider {
  readonly #provider: Readonly<{ id: string; displayName: string }>;
  readonly #fixture: DeterministicSpeechFixture;

  public constructor(
    provider: Readonly<{ id: string; displayName: string }>,
    fixture: DeterministicSpeechFixture,
  ) {
    this.#provider = provider;
    this.#fixture = fixture;
  }

  public async transcribe(
    request: SpeechToTextRequest,
  ): Promise<SpeechToTextResult> {
    const byteLength = await consumeAudio(request.audio.body);
    const words =
      this.#fixture.text.length === 0 ? [] : this.#fixture.text.split(/\s+/u);
    const hasTimestamps = this.#fixture.timestamps ?? true;
    const duration = words.length * 250;
    const normalizedWords = words.map((text, index) => ({
      text,
      timing: hasTimestamps
        ? ({
            status: 'known',
            startMs: index * 250,
            endMs: (index + 1) * 250,
          } as const)
        : ({ status: 'unknown' } as const),
      confidence: { status: 'known', value: 1 } as const,
    }));
    const segment: NormalizedTranscriptSegment = Object.freeze({
      text: this.#fixture.text,
      timing: hasTimestamps
        ? ({ status: 'known', startMs: 0, endMs: duration } as const)
        : ({ status: 'unknown' } as const),
      words: hasTimestamps
        ? ({ status: 'known', items: normalizedWords } as const)
        : ({ status: 'unknown' } as const),
    });
    const raw = {
      byte_length: byteLength,
      language: this.#fixture.language ?? null,
      text: this.#fixture.text,
      timestamps: hasTimestamps,
    };

    return Object.freeze({
      text: this.#fixture.text,
      segments: Object.freeze([segment]),
      language:
        this.#fixture.language === undefined
          ? ({ status: 'unknown' } as const)
          : ({ status: 'known', value: this.#fixture.language } as const),
      timingAvailability: Object.freeze({
        segments: hasTimestamps ? 'known' : 'unknown',
        words: hasTimestamps ? 'known' : 'unknown',
      }),
      effectiveContext: Object.freeze([...request.context]),
      operation: operation(
        this.#provider,
        'deterministic-speech-v1',
        request.configuration,
      ),
      rawResponse: rawResponse(raw),
    });
  }
}

export class DeterministicStructuredGenerationProvider implements StructuredGenerationProvider {
  readonly #provider: Readonly<{ id: string; displayName: string }>;
  readonly #output: JsonValue;

  public constructor(
    provider: Readonly<{ id: string; displayName: string }>,
    output: JsonValue,
  ) {
    this.#provider = provider;
    this.#output = output;
  }

  public async generate<T extends JsonValue>(
    request: StructuredGenerationRequest<T>,
  ): Promise<StructuredGenerationResult<T>> {
    const data = request.outputSchema.parse(this.#output);
    const raw = { output: this.#output };
    return Object.freeze({
      data,
      schema: Object.freeze({
        id: request.outputSchema.id,
        version: request.outputSchema.version,
      }),
      prompt: request.prompt,
      effectiveMessages: Object.freeze([...request.messages]),
      usage: { status: 'unknown' as const },
      operation: operation(
        this.#provider,
        'deterministic-structured-v1',
        request.configuration,
      ),
      rawResponse: rawResponse(raw),
    });
  }
}

function deterministicVector(text: string, dimension: number): number[] {
  return Array.from({ length: dimension }, (_, dimensionIndex) => {
    let value = (dimensionIndex + 1) * 31;
    for (const [characterIndex, character] of [...text].entries()) {
      value += (character.codePointAt(0) ?? 0) * (characterIndex + 1);
    }
    return ((value % 2001) - 1000) / 1000;
  });
}

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly #provider: Readonly<{ id: string; displayName: string }>;
  readonly #dimension: number;

  public constructor(
    provider: Readonly<{ id: string; displayName: string }>,
    dimension = 4,
  ) {
    if (!Number.isSafeInteger(dimension) || dimension <= 0) {
      throw new RangeError(
        'Fake embedding dimension must be a positive integer.',
      );
    }
    this.#provider = provider;
    this.#dimension = dimension;
  }

  public async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const embeddings = request.fragments.map(({ id, text }) => ({
      fragmentId: id,
      vector: deterministicVector(text, this.#dimension),
    }));
    return Object.freeze({
      embeddings: Object.freeze(embeddings),
      dimension: this.#dimension,
      usage: { status: 'unknown' as const },
      operation: operation(
        this.#provider,
        'deterministic-embedding-v1',
        request.configuration,
      ),
      rawResponse: rawResponse({ embeddings }),
    });
  }
}

export type DeterministicAiFactoryOptions = Readonly<{
  providerId?: string;
  displayName?: string;
  speech?: DeterministicSpeechFixture | false;
  structuredOutput?: JsonValue | false;
  embeddingDimension?: number | false;
}>;

export function createDeterministicAiProviderFactory(
  options: DeterministicAiFactoryOptions = {},
): AiProviderFactory {
  const provider = Object.freeze({
    id: options.providerId ?? 'deterministic-fake',
    displayName: options.displayName ?? 'Deterministic fake provider',
  });
  const capabilities = [
    ...(options.speech === false ? [] : (['speech_to_text'] as const)),
    ...(options.structuredOutput === false
      ? []
      : (['structured_generation'] as const)),
    ...(options.embeddingDimension === false ? [] : (['embeddings'] as const)),
  ];
  const descriptor: AiProviderDescriptor = Object.freeze({
    ...provider,
    capabilities: Object.freeze(capabilities),
    disclosure: Object.freeze({
      contentRecipient: 'In-process deterministic test fake',
      external: false,
      retention: {
        status: 'known' as const,
        value: 'No provider retention',
      },
      trainingUse: { status: 'known' as const, value: false },
    }),
  });

  return Object.freeze({
    descriptor,
    create(): AiProviderAdapter {
      return Object.freeze({
        descriptor,
        ...(options.speech === false
          ? {}
          : {
              speech_to_text: new DeterministicSpeechToTextProvider(
                provider,
                options.speech ?? { text: 'Deterministic transcript.' },
              ),
            }),
        ...(options.structuredOutput === false
          ? {}
          : {
              structured_generation:
                new DeterministicStructuredGenerationProvider(
                  provider,
                  options.structuredOutput ?? null,
                ),
            }),
        ...(options.embeddingDimension === false
          ? {}
          : {
              embeddings: new DeterministicEmbeddingProvider(
                provider,
                options.embeddingDimension,
              ),
            }),
      });
    },
  });
}

function writeSignature(write: RawResponseWrite, bodyHash: string): string {
  return canonicalJson({
    body_hash: bodyHash,
    capability: write.capability,
    captured_at: write.capturedAt.toISOString(),
    media_type: write.response.mediaType,
    operation: write.operation,
    provider_request_id: write.response.providerRequestId ?? null,
    retention: write.retention,
  });
}

/** Exact, immutable raw-response fake suitable for provider contract tests. */
export class InMemoryRawResponseStore implements RawResponseStore {
  readonly #signatures = new Map<string, string>();
  readonly #references = new Map<string, RawResponseReference>();
  readonly #responses = new Map<string, RawProviderResponse>();

  public async putImmutable(
    write: RawResponseWrite,
  ): Promise<RawResponseReference> {
    const body = Uint8Array.from(write.response.body);
    const bodyHash = sha256(body);
    const signature = writeSignature(write, bodyHash);
    const existingSignature = this.#signatures.get(write.id);
    if (existingSignature !== undefined) {
      if (existingSignature !== signature) throw new RawResponseConflictError();
      const existingReference = this.#references.get(write.id);
      if (existingReference === undefined) {
        throw new Error('Raw-response fake contains inconsistent state.');
      }
      return existingReference;
    }

    const reference: RawResponseReference = Object.freeze({
      id: write.id,
      capability: write.capability,
      mediaType: write.response.mediaType,
      byteLength: BigInt(body.byteLength),
      sha256: bodyHash,
      retention: write.retention,
      state: write.retention === 'do_not_retain' ? 'not_retained' : 'retained',
    });
    this.#signatures.set(write.id, signature);
    this.#references.set(write.id, reference);
    if (reference.state === 'retained') {
      this.#responses.set(write.id, Object.freeze({ ...write.response, body }));
    }
    return reference;
  }

  public async open(id: string): Promise<RawProviderResponse> {
    const response = this.#responses.get(id);
    if (response === undefined) throw new RawResponseNotAvailableError();
    return Object.freeze({ ...response, body: Uint8Array.from(response.body) });
  }
}
