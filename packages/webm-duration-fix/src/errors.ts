export type WebmFinalizeErrorCode =
  | 'unsupported-input'
  | 'invalid-ebml'
  | 'numeric-overflow'
  | 'truncated-data'
  | 'resource-limit';

export class WebmFinalizeError extends Error {
  public constructor(
    public readonly code: WebmFinalizeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WebmFinalizeError';
  }
}

export class UnsupportedWebmInputError extends WebmFinalizeError {
  public constructor(message: string, options?: ErrorOptions) {
    super('unsupported-input', message, options);
    this.name = 'UnsupportedWebmInputError';
  }
}

export class InvalidEbmlError extends WebmFinalizeError {
  public constructor(message: string, options?: ErrorOptions) {
    super('invalid-ebml', message, options);
    this.name = 'InvalidEbmlError';
  }
}

export class NumericOverflowError extends WebmFinalizeError {
  public constructor(message: string, options?: ErrorOptions) {
    super('numeric-overflow', message, options);
    this.name = 'NumericOverflowError';
  }
}

export class TruncatedDataError extends WebmFinalizeError {
  public constructor(message: string, options?: ErrorOptions) {
    super('truncated-data', message, options);
    this.name = 'TruncatedDataError';
  }
}

/** Raised when input exceeds a resource policy supplied by the caller. */
export class ResourceLimitError extends WebmFinalizeError {
  public constructor(message: string, options?: ErrorOptions) {
    super('resource-limit', message, options);
    this.name = 'ResourceLimitError';
  }
}
