import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";

import {
  ConflictError,
  createManifest,
  FinalizationService,
  installSchema,
  LocalBlobStore,
  RetryableError,
} from "./finalization-protocol.mjs";

const { Pool } = pg;
const chunks = [Buffer.from("recoverable "), Buffer.from("audio")];
const manifest = createManifest(chunks);

let container;
let pool;
let storageRoot;
let blobStore;
let service;

before(async () => {
  container = await new PostgreSqlContainer("postgres:17.6-alpine").start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await installSchema(pool);
});

beforeEach(async () => {
  await pool.query(
    "TRUNCATE blob_sweep_candidates, recording_chunks, recording_uploads CASCADE",
  );
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  storageRoot = await mkdtemp(join(tmpdir(), "audio-finalization-spike-"));
  blobStore = new LocalBlobStore(storageRoot);
  service = new FinalizationService(pool, blobStore);
});

after(async () => {
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  await pool?.end();
  await container?.stop();
});

async function seedUpload(uploadId = "upload-1", recordingId = "recording-1") {
  await service.createUpload({ uploadId, recordingId });
  for (let index = 0; index < chunks.length; index += 1) {
    await service.addChunk(uploadId, index, chunks[index]);
  }
}

async function uploadState(uploadId = "upload-1") {
  return (
    await pool.query("SELECT * FROM recording_uploads WHERE id = $1", [
      uploadId,
    ])
  ).rows[0];
}

test("CAP-003 CAP-004: blob failure leaves prepared state and retry completes once", async () => {
  await seedUpload();

  await assert.rejects(
    service.finalize("upload-1", manifest, { failBlobBeforeRename: true }),
    RetryableError,
  );
  const prepared = await uploadState();
  assert.equal(prepared.state, "prepared");
  await assert.rejects(blobStore.stat(prepared.final_blob_key), {
    code: "ENOENT",
  });

  const durable = await service.finalize("upload-1", manifest);
  assert.equal(durable.state, "durable");
  assert.equal((await blobStore.listFinal()).length, 1);
});

test("CAP-003 CAP-004: committed blob survives failed DB confirmation and retry reconciles it", async () => {
  await seedUpload();

  await assert.rejects(
    service.finalize("upload-1", manifest, {
      failDatabaseConfirmation: true,
    }),
    RetryableError,
  );
  const prepared = await uploadState();
  assert.equal(prepared.state, "prepared");
  assert.deepEqual(await blobStore.stat(prepared.final_blob_key), {
    key: prepared.final_blob_key,
    byteSize: manifest.finalByteSize,
    sha256: manifest.finalSha256,
    modifiedAt: (await blobStore.stat(prepared.final_blob_key)).modifiedAt,
  });

  const durable = await service.finalize("upload-1", manifest);
  assert.equal(durable.state, "durable");
  assert.equal((await blobStore.listFinal()).length, 1);
});

test("DATA-021 CAP-004: duplicate chunks and manifests are idempotent; conflicts are rejected", async () => {
  await seedUpload();
  await service.addChunk("upload-1", 0, chunks[0]);
  await assert.rejects(
    service.addChunk("upload-1", 0, Buffer.from("different")),
    ConflictError,
  );

  await service.prepare("upload-1", manifest);
  await service.prepare("upload-1", manifest);
  await service.addChunk("upload-1", 0, chunks[0]);
  await assert.rejects(
    service.addChunk("upload-1", 2, Buffer.from("late chunk")),
    ConflictError,
  );
  const conflictingManifest = structuredClone(manifest);
  conflictingManifest.finalSha256 = "0".repeat(64);
  await assert.rejects(
    service.prepare("upload-1", conflictingManifest),
    ConflictError,
  );

  await service.finalize("upload-1", manifest);
  await service.finalize("upload-1", manifest);
  assert.equal((await blobStore.listFinal()).length, 1);
});

test("DATA-021 CAP-004: a conflicting immutable final blob is never replaced", async () => {
  await seedUpload();
  const prepared = await service.prepare("upload-1", manifest);
  const conflictingBytes = Buffer.from("not the recording");
  await blobStore.putImmutable(prepared.final_blob_key, conflictingBytes);
  const conflictingSha256 = (await blobStore.stat(prepared.final_blob_key))
    .sha256;

  await assert.rejects(service.finalize("upload-1", manifest), ConflictError);
  assert.equal((await uploadState()).state, "prepared");
  assert.equal(
    (await blobStore.stat(prepared.final_blob_key)).sha256,
    conflictingSha256,
  );
  assert.notEqual(
    (await blobStore.stat(prepared.final_blob_key)).sha256,
    manifest.finalSha256,
  );
});

test("CAP-003: orphan discovery is two-pass and protects every prepared reference", async () => {
  await seedUpload();
  const prepared = await service.prepare("upload-1", manifest);
  await blobStore.putImmutable(prepared.final_blob_key, Buffer.concat(chunks));
  const orphanKey = "final/unreferenced/original.audio";
  await blobStore.putImmutable(orphanKey, Buffer.from("orphan"));

  const discoveredAt = new Date("2026-08-01T00:00:00Z");
  await service.discoverOrphans(discoveredAt);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT blob_key FROM blob_sweep_candidates ORDER BY blob_key",
      )
    ).rows,
    [{ blob_key: orphanKey }],
  );

  assert.deepEqual(
    await service.sweepOrphans(new Date("2026-07-31T23:59:59Z")),
    [],
  );
  assert.deepEqual(
    await service.sweepOrphans(new Date("2026-08-02T00:00:00Z")),
    [orphanKey],
  );
  await assert.rejects(blobStore.stat(orphanKey), { code: "ENOENT" });
  assert.equal(
    (await blobStore.stat(prepared.final_blob_key)).sha256,
    manifest.finalSha256,
  );
});

test("CAP-003: sweep rechecks ownership and cancels a stale orphan candidate", async () => {
  const key = "final/recording-1/original.audio";
  await blobStore.putImmutable(key, Buffer.concat(chunks));
  const discoveredAt = new Date("2026-08-01T00:00:00Z");
  await service.discoverOrphans(discoveredAt);

  await seedUpload();
  await service.prepare("upload-1", manifest);
  assert.deepEqual(
    await service.sweepOrphans(new Date("2026-08-02T00:00:00Z")),
    [],
  );
  assert.equal((await blobStore.stat(key)).sha256, manifest.finalSha256);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::integer AS count FROM blob_sweep_candidates",
      )
    ).rows[0].count,
    0,
  );
});
