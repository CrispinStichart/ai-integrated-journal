import { DomainInvariantError } from './errors.js';

declare const uuidV7Brand: unique symbol;

/** Canonical lowercase UUIDv7. The tag prevents mixing unrelated entity IDs. */
export type UuidV7<Tag extends string = string> = string & {
  readonly [uuidV7Brand]: Tag;
};

export type DomainId<Tag extends string> = UuidV7<Tag>;

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_UUID_TIMESTAMP = 0xffffffffffff;

export function isUuidV7(value: unknown): value is UuidV7 {
  return typeof value === 'string' && UUID_V7_PATTERN.test(value);
}

export function parseUuidV7<Tag extends string = string>(
  value: string,
): UuidV7<Tag> {
  if (!isUuidV7(value)) {
    throw new DomainInvariantError(
      `Expected a canonical lowercase UUIDv7, received "${value}".`,
    );
  }

  return value as UuidV7<Tag>;
}

export interface UuidV7GenerationOptions {
  readonly timestamp?: number;
  readonly randomBytes?: (length: number) => Uint8Array;
}

function secureRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** Generates an RFC 9562 UUIDv7 without relying on a persistence tier. */
export function createUuidV7<Tag extends string = string>(
  options: UuidV7GenerationOptions = {},
): UuidV7<Tag> {
  const timestamp = options.timestamp ?? Date.now();
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    timestamp > MAX_UUID_TIMESTAMP
  ) {
    throw new DomainInvariantError(
      'A UUIDv7 timestamp must be a non-negative 48-bit integer.',
    );
  }

  const bytes = (options.randomBytes ?? secureRandomBytes)(16);
  if (bytes.length !== 16) {
    throw new DomainInvariantError(
      'A UUIDv7 random source must return exactly 16 bytes.',
    );
  }

  const result = Uint8Array.from(bytes);
  let remainingTimestamp = timestamp;
  for (let index = 5; index >= 0; index -= 1) {
    result[index] = remainingTimestamp % 256;
    remainingTimestamp = Math.floor(remainingTimestamp / 256);
  }
  result[6] = 0x70 | ((result.at(6) ?? 0) & 0x0f);
  result[8] = 0x80 | ((result.at(8) ?? 0) & 0x3f);

  const hex = Array.from(result, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return parseUuidV7<Tag>(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

export function uuidV7Timestamp(value: UuidV7): number {
  return Number.parseInt(value.slice(0, 8) + value.slice(9, 13), 16);
}
