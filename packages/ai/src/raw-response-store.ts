import type {
  AiCapability,
  AiOperationSnapshot,
  RawProviderResponse,
} from './common.js';

export type RawResponseRetention =
  'days_30' | 'days_90' | 'do_not_retain' | 'indefinite' | 'year_1';

export type RawResponseWrite = Readonly<{
  id: string;
  capability: AiCapability;
  capturedAt: Date;
  response: RawProviderResponse;
  operation: AiOperationSnapshot;
  retention: RawResponseRetention;
}>;

export type RawResponseReference = Readonly<{
  id: string;
  capability: AiCapability;
  mediaType: string;
  byteLength: bigint;
  sha256: string;
  retention: RawResponseRetention;
  state: 'not_retained' | 'retained';
}>;

/**
 * Immutable persistence boundary for exact provider response bodies.
 * Implementations must calculate integrity over the supplied bytes and must
 * reject a conflicting retry with the same ID.
 */
export interface RawResponseStore {
  putImmutable(response: RawResponseWrite): Promise<RawResponseReference>;
  open(id: string): Promise<RawProviderResponse>;
}

export class RawResponseConflictError extends Error {
  public constructor() {
    super('Raw provider response conflicts with immutable storage.');
    this.name = 'RawResponseConflictError';
  }
}

export class RawResponseNotAvailableError extends Error {
  public constructor() {
    super('Raw provider response is not retained or does not exist.');
    this.name = 'RawResponseNotAvailableError';
  }
}
