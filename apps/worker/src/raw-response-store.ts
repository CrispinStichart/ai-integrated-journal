import { createHash } from 'node:crypto';

import {
  RawResponseNotAvailableError,
  type RawProviderResponse,
  type RawResponseReference,
  type RawResponseStore,
  type RawResponseWrite,
} from '@journal/ai';
import { transcriptionRuns, type JournalDatabase } from '@journal/database';
import { BlobNotFoundError, type BlobStore } from '@journal/storage';
import { eq } from 'drizzle-orm';

function responseKey(capability: string, id: string): string {
  return `provider-responses/${capability}/${id}/raw.response`;
}

function metadataKey(capability: string, id: string): string {
  return `provider-responses/${capability}/${id}/metadata.json`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

async function* oneChunk(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let byteLength = 0;
  for await (const part of stream) {
    parts.push(part);
    byteLength += part.byteLength;
  }
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return body;
}

/** Stores exact provider bytes in the immutable BlobStore namespace. */
export class BlobRawResponseStore implements RawResponseStore {
  public constructor(
    private readonly database: JournalDatabase,
    private readonly blobs: BlobStore,
  ) {}

  public async putImmutable(
    write: RawResponseWrite,
  ): Promise<RawResponseReference> {
    const metadata = new TextEncoder().encode(
      canonicalJson({
        capability: write.capability,
        capturedAt: write.capturedAt.toISOString(),
        mediaType: write.response.mediaType,
        operation: write.operation,
        providerRequestId: write.response.providerRequestId ?? null,
        retention: write.retention,
      }),
    );
    await this.blobs.putImmutable(oneChunk(metadata), {
      key: metadataKey(write.capability, write.id),
    });
    if (write.retention === 'do_not_retain') {
      return Object.freeze({
        id: write.id,
        capability: write.capability,
        mediaType: write.response.mediaType,
        byteLength: BigInt(write.response.body.byteLength),
        sha256: createHash('sha256').update(write.response.body).digest('hex'),
        retention: write.retention,
        state: 'not_retained',
      });
    }
    const stored = await this.blobs.putImmutable(
      oneChunk(write.response.body),
      { key: responseKey(write.capability, write.id) },
    );
    return Object.freeze({
      id: write.id,
      capability: write.capability,
      mediaType: write.response.mediaType,
      byteLength: stored.byteSize,
      sha256: stored.sha256,
      retention: write.retention,
      state: 'retained',
    });
  }

  public async open(id: string): Promise<RawProviderResponse> {
    const [run] = await this.database
      .select({
        blobKey: transcriptionRuns.rawResponseBlobKey,
        mediaType: transcriptionRuns.rawResponseMediaType,
        providerRequestId: transcriptionRuns.rawResponseProviderRequestId,
      })
      .from(transcriptionRuns)
      .where(eq(transcriptionRuns.rawResponseId, id))
      .limit(1);
    if (run?.blobKey === null || run?.mediaType === null || run === undefined) {
      throw new RawResponseNotAvailableError();
    }
    try {
      return Object.freeze({
        body: await readAll(await this.blobs.open(run.blobKey)),
        mediaType: run.mediaType,
        ...(run.providerRequestId === null
          ? {}
          : { providerRequestId: run.providerRequestId }),
      });
    } catch (error) {
      if (error instanceof BlobNotFoundError) {
        throw new RawResponseNotAvailableError();
      }
      throw error;
    }
  }
}

export function rawResponseBlobKey(capability: string, id: string): string {
  return responseKey(capability, id);
}
