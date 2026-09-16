/** Server-only OpenAI HTTP adapter. Provider response shapes stay in this module. */
import { createHash } from 'node:crypto';
import {
  AiProviderOperationError,
  type AiOperationSnapshot,
  type AiProviderDescriptor,
  type JsonObject,
  type JsonValue,
  type RawProviderResponse,
  type TokenUsage,
} from './common.js';
import type { AiProviderFactory } from './provider-factory.js';
import type {
  SpeechToTextRequest,
  SpeechToTextResult,
  NormalizedTranscriptSegment,
  TranscriptTiming,
} from './speech-to-text.js';
import type {
  StructuredGenerationRequest,
  StructuredGenerationResult,
} from './structured-generation.js';
import { canonicalProviderJson } from './provider-security.js';

export const openAiDescriptor: AiProviderDescriptor = {
  id: 'openai',
  displayName: 'OpenAI',
  capabilities: ['structured_generation', 'speech_to_text'],
  disclosure: {
    contentRecipient: 'OpenAI',
    external: true,
    retention: {
      status: 'known',
      value:
        'Responses are sent with store=false. Standard abuse monitoring may retain text inputs and outputs for up to 30 days. Audio transcription has no application-state or abuse-monitoring retention. Account-specific controls and policy exceptions may apply.',
      detail: 'https://developers.openai.com/api/docs/guides/your-data',
    },
    trainingUse: {
      status: 'known',
      value: false,
      detail:
        'API content is not used for training by default; account owners can opt in to data sharing.',
    },
    privacyPolicyUrl: 'https://openai.com/policies/privacy-policy/',
  },
};
const MAX_AUDIO_BYTES = 25_000_000;
const AUDIO_MODELS = new Set([
  'gpt-transcribe',
  'gpt-4o-transcribe',
  'gpt-4o-mini-transcribe',
  'whisper-1',
]);
const AUDIO_EXTENSIONS: Readonly<Record<string, string>> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/mpga': 'mpga',
  'video/mpeg': 'mpeg',
};
function invalid(): AiProviderOperationError {
  return new AiProviderOperationError({
    code: 'provider_invalid_request',
    retryable: false,
  });
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw invalid();
  return value;
}
function timing(value: Record<string, unknown>): TranscriptTiming {
  const { start, end } = value;
  if (start === undefined || end === undefined) return { status: 'unknown' };
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    !Number.isSafeInteger(Math.round(end * 1000))
  )
    throw invalid();
  return {
    status: 'known',
    startMs: Math.round(start * 1000),
    endMs: Math.round(end * 1000),
  };
}
function usage(value: unknown): TokenUsage {
  if (value === undefined || value === null) return { status: 'unknown' };
  const item = record(value);
  const values = [item.input_tokens, item.output_tokens, item.total_tokens];
  if (
    !values.every(
      (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0,
    )
  )
    return { status: 'unknown' };
  return {
    status: 'known',
    inputTokens: item.input_tokens as number,
    outputTokens: item.output_tokens as number,
    totalTokens: item.total_tokens as number,
  };
}
function snapshot(
  model: string,
  parameters: JsonObject,
  start: number,
  response: Record<string, unknown>,
): AiOperationSnapshot {
  return {
    provider: { id: 'openai', displayName: 'OpenAI', adapterVersion: '1' },
    model: {
      id: model,
      ...(typeof response.model === 'string' && response.model !== model
        ? { version: response.model }
        : {}),
    },
    configuration: {
      parameters,
      fingerprint: createHash('sha256')
        .update(canonicalProviderJson(parameters))
        .digest('hex'),
    },
    processingTimeMs: Math.max(0, Math.round(performance.now() - start)),
  };
}
function parameters(
  configuration: JsonObject,
  kind: 'text' | 'audio',
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const name of kind === 'text'
    ? ['temperature', 'top_p', 'max_output_tokens']
    : ['temperature', 'language']) {
    const value = configuration[name];
    if (value === undefined) continue;
    if (name === 'language') {
      if (typeof value !== 'string' || !/^[a-z]{2,3}$/.test(value))
        throw invalid();
    } else {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        throw invalid();
      if (name === 'temperature' && value > (kind === 'audio' ? 1 : 2))
        throw invalid();
      if (name === 'top_p' && value > 1) throw invalid();
      if (
        name === 'max_output_tokens' &&
        (!Number.isSafeInteger(value) || value < 1)
      )
        throw invalid();
    }
    result[name] = value;
  }
  return result;
}
function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}
async function cancellable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    aborted(signal);
  }
  let onAbort: () => void = () => {};
  const cancellation = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, cancellation]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function createOpenAiProviderFactory(
  options: { fetch?: typeof fetch; timeoutMilliseconds?: number } = {},
): AiProviderFactory {
  const transport = options.fetch ?? globalThis.fetch;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 120_000;
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1)
    throw new RangeError('Invalid provider timeout.');
  return {
    descriptor: openAiDescriptor,
    create(settings) {
      const apiKey = settings.apiKey;
      if (typeof apiKey !== 'string' || !apiKey.trim())
        throw new AiProviderOperationError({
          code: 'provider_authentication_failed',
          retryable: false,
        });
      const models = record(settings.models);
      function modelFor(capability: string): string {
        const model = string(models[capability]);
        if (!model.trim()) throw invalid();
        return model;
      }
      async function call(
        path: string,
        body: BodyInit,
        signal: AbortSignal,
        json = false,
      ): Promise<{ value: Record<string, unknown>; raw: RawProviderResponse }> {
        try {
          const response = await transport(
            `https://api.openai.com/v1/${path}`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiKey}`,
                ...(json ? { 'Content-Type': 'application/json' } : {}),
              },
              body,
              signal,
              redirect: 'error',
            },
          );
          if (!response.ok) {
            // Never read or attach error response bodies, which can echo content.
            await response.body?.cancel();
            const delay = response.headers.get('retry-after');
            const parsedDelay =
              delay === null
                ? NaN
                : /^\d+(\.\d+)?$/.test(delay)
                  ? Math.ceil(Number(delay) * 1000)
                  : Math.max(0, Date.parse(delay) - Date.now());
            const code =
              response.status === 401 || response.status === 403
                ? 'provider_authentication_failed'
                : response.status === 429
                  ? 'provider_rate_limited'
                  : response.status === 408
                    ? 'provider_timeout'
                    : response.status >= 500
                      ? 'provider_unavailable'
                      : 'provider_invalid_request';
            throw new AiProviderOperationError({
              code,
              retryable:
                response.status === 429 ||
                response.status === 408 ||
                response.status >= 500,
              ...(Number.isSafeInteger(parsedDelay) &&
              parsedDelay >= 0 &&
              Number.isFinite(new Date(Date.now() + parsedDelay).getTime())
                ? { retryAfterMilliseconds: parsedDelay }
                : {}),
            });
          }
          const bytes = new Uint8Array(await response.arrayBuffer());
          aborted(signal);
          let value: Record<string, unknown>;
          try {
            value = record(
              JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(bytes),
              ),
            );
          } catch {
            throw invalid();
          }
          const requestId = response.headers.get('x-request-id');
          return {
            value,
            raw: {
              body: bytes,
              mediaType:
                response.headers.get('content-type') ?? 'application/json',
              ...(requestId ? { providerRequestId: requestId } : {}),
            },
          };
        } catch (error) {
          if (signal.aborted) throw error;
          if (error instanceof AiProviderOperationError) throw error;
          throw new AiProviderOperationError({
            code: 'provider_unavailable',
            retryable: true,
          });
        }
      }
      async function run<T>(
        signal: AbortSignal | undefined,
        action: (effectiveSignal: AbortSignal) => Promise<T>,
      ): Promise<T> {
        aborted(signal);
        const timeout = AbortSignal.timeout(timeoutMilliseconds);
        const effective = signal ? AbortSignal.any([signal, timeout]) : timeout;
        try {
          return await cancellable(action(effective), effective);
        } catch (error) {
          aborted(signal);
          if (timeout.aborted)
            throw new AiProviderOperationError({
              code: 'provider_timeout',
              retryable: true,
            });
          throw error;
        }
      }
      return {
        descriptor: openAiDescriptor,
        structured_generation: {
          async generate<T extends JsonValue>(
            request: StructuredGenerationRequest<T>,
          ): Promise<StructuredGenerationResult<T>> {
            return run(request.signal, async (signal) => {
              const start = performance.now();
              const model = modelFor('structured_generation');
              const config = {
                ...parameters(request.configuration, 'text'),
                model,
                store: false,
                strict: false,
              };
              const messages = request.messages.map((message) => ({
                ...message,
              }));
              const { value, raw } = await call(
                'responses',
                JSON.stringify({
                  ...parameters(request.configuration, 'text'),
                  model,
                  store: false,
                  input: messages,
                  text: {
                    format: {
                      type: 'json_schema',
                      name: `schema_${createHash('sha256').update(request.outputSchema.id).digest('hex').slice(0, 40)}`,
                      schema: request.outputSchema.jsonSchema,
                      strict: false,
                    },
                  },
                }),
                signal,
                true,
              );
              if (value.status !== 'completed' || !Array.isArray(value.output))
                throw invalid();
              const texts: string[] = [];
              for (const output of value.output) {
                const item = record(output);
                if (item.type === 'reasoning') continue;
                if (
                  item.type !== 'message' ||
                  item.status !== 'completed' ||
                  !Array.isArray(item.content)
                )
                  throw invalid();
                for (const content of item.content) {
                  const part = record(content);
                  if (part.type !== 'output_text') throw invalid();
                  texts.push(string(part.text));
                }
              }
              let data: T;
              try {
                data = request.outputSchema.parse(JSON.parse(texts.join('')));
              } catch {
                throw invalid();
              }
              return {
                data,
                schema: {
                  id: request.outputSchema.id,
                  version: request.outputSchema.version,
                },
                prompt: { ...request.prompt },
                effectiveMessages: messages,
                usage: usage(value.usage),
                operation: snapshot(model, config, start, value),
                rawResponse: raw,
              };
            });
          },
        },
        speech_to_text: {
          async transcribe(
            request: SpeechToTextRequest,
          ): Promise<SpeechToTextResult> {
            return run(request.signal, async (signal) => {
              const start = performance.now();
              const model = modelFor('speech_to_text');
              if (!AUDIO_MODELS.has(model)) throw invalid();
              const mediaType =
                request.audio.mediaType.split(';')[0]?.trim().toLowerCase() ??
                '';
              const extension = AUDIO_EXTENSIONS[mediaType];
              if (
                !extension ||
                (request.audio.byteLength !== undefined &&
                  (request.audio.byteLength < 0n ||
                    request.audio.byteLength > BigInt(MAX_AUDIO_BYTES)))
              )
                throw invalid();
              const config: Record<string, JsonValue> = {
                ...parameters(request.configuration, 'audio'),
                model,
                response_format:
                  model === 'whisper-1' ? 'verbose_json' : 'json',
              };
              const chunks: Uint8Array<ArrayBuffer>[] = [];
              let size = 0;
              const iterator = request.audio.body[Symbol.asyncIterator]();
              let complete = false;
              try {
                while (true) {
                  const next = await cancellable(iterator.next(), signal);
                  if (next.done) {
                    complete = true;
                    break;
                  }
                  size += next.value.byteLength;
                  if (size > MAX_AUDIO_BYTES) throw invalid();
                  chunks.push(new Uint8Array(next.value));
                }
              } finally {
                if (!complete && iterator.return)
                  void iterator.return().catch(() => {});
              }
              if (
                size === 0 ||
                (request.audio.byteLength !== undefined &&
                  BigInt(size) !== request.audio.byteLength)
              )
                throw invalid();
              const form = new FormData();
              const filename = request.audio.fileName;
              form.set(
                'file',
                new Blob(chunks, { type: mediaType }),
                filename &&
                  /^[a-zA-Z0-9._-]+$/.test(filename) &&
                  filename.toLowerCase().endsWith(`.${extension}`)
                  ? filename
                  : `recording.${extension}`,
              );
              for (const [key, value] of Object.entries(config))
                form.set(key, String(value));
              if (model === 'whisper-1') {
                form.append('timestamp_granularities[]', 'segment');
                form.append('timestamp_granularities[]', 'word');
                config.timestamp_granularities = ['segment', 'word'];
              }
              const context = request.context.map((item) => ({ ...item }));
              if (context.length)
                form.set('prompt', context.map((item) => item.text).join('\n'));
              const { value, raw } = await call(
                'audio/transcriptions',
                form,
                signal,
              );
              const text = string(value.text);
              const segments: NormalizedTranscriptSegment[] = [];
              if (
                value.segments !== undefined &&
                !Array.isArray(value.segments)
              )
                throw invalid();
              if (value.words !== undefined && !Array.isArray(value.words))
                throw invalid();
              const words = Array.isArray(value.words)
                ? value.words.map((word) => {
                    const item = record(word);
                    return {
                      text: string(item.word),
                      timing: timing(item),
                      confidence: { status: 'unknown' as const },
                    };
                  })
                : undefined;
              const assignedWords = new Set<number>();
              if (Array.isArray(value.segments)) {
                for (const segment of value.segments) {
                  const item = record(segment);
                  const range = timing(item);
                  const items = words?.filter((word, index) => {
                    const fits =
                      range.status === 'known' &&
                      word.timing.status === 'known' &&
                      word.timing.startMs >= range.startMs &&
                      word.timing.startMs < range.endMs &&
                      !assignedWords.has(index);
                    if (fits) assignedWords.add(index);
                    return fits;
                  });
                  segments.push({
                    text: string(item.text),
                    timing: range,
                    words: items?.length
                      ? { status: 'known', items }
                      : { status: 'unknown' },
                  });
                }
              }
              if (!segments.length && text)
                segments.push({
                  text,
                  timing: { status: 'unknown' },
                  words: words?.length
                    ? { status: 'known', items: words }
                    : { status: 'unknown' },
                });
              const availability = (known: number, total: number) =>
                known === 0
                  ? ('unknown' as const)
                  : known === total
                    ? ('known' as const)
                    : ('partial' as const);
              return {
                text,
                segments,
                language:
                  typeof value.language === 'string' && value.language
                    ? { status: 'known', value: value.language }
                    : { status: 'unknown' },
                timingAvailability: {
                  segments: availability(
                    segments.filter((item) => item.timing.status === 'known')
                      .length,
                    segments.length,
                  ),
                  words: availability(
                    segments.filter(
                      (item) =>
                        item.words.status === 'known' &&
                        item.words.items.every(
                          (word) => word.timing.status === 'known',
                        ),
                    ).length,
                    segments.length,
                  ),
                },
                effectiveContext: context,
                operation: snapshot(model, config, start, value),
                rawResponse: raw,
              };
            });
          },
        },
      };
    },
  };
}
