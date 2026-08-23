import type {
  AiOperationSnapshot,
  JsonObject,
  KnownOrUnknown,
  RawProviderResponse,
} from './common.js';

export type SpeechAudioInput = Readonly<{
  body: AsyncIterable<Uint8Array>;
  mediaType: string;
  byteLength?: bigint;
  fileName?: string;
}>;

export type SpeechContextItem = Readonly<{
  text: string;
  purpose: string;
  version?: string;
}>;

export type SpeechToTextRequest = Readonly<{
  audio: SpeechAudioInput;
  context: readonly SpeechContextItem[];
  configuration: JsonObject;
}>;

export type TranscriptTiming =
  | Readonly<{ status: 'known'; startMs: number; endMs: number }>
  | Readonly<{ status: 'unknown' }>;

export type NormalizedTranscriptWord = Readonly<{
  text: string;
  timing: TranscriptTiming;
  confidence: KnownOrUnknown<number>;
}>;

export type NormalizedTranscriptSegment = Readonly<{
  text: string;
  timing: TranscriptTiming;
  words:
    | Readonly<{
        status: 'known';
        items: readonly NormalizedTranscriptWord[];
      }>
    | Readonly<{ status: 'unknown' }>;
}>;

export type TranscriptTimingAvailability = 'known' | 'partial' | 'unknown';

export type SpeechToTextResult = Readonly<{
  text: string;
  segments: readonly NormalizedTranscriptSegment[];
  language: KnownOrUnknown<string>;
  timingAvailability: Readonly<{
    segments: TranscriptTimingAvailability;
    words: TranscriptTimingAvailability;
  }>;
  /** The exact content-bearing context actually sent by the adapter. */
  effectiveContext: readonly SpeechContextItem[];
  operation: AiOperationSnapshot;
  rawResponse: RawProviderResponse;
}>;

/** Capability port for provider-neutral speech recognition. */
export interface SpeechToTextProvider {
  transcribe(request: SpeechToTextRequest): Promise<SpeechToTextResult>;
}
