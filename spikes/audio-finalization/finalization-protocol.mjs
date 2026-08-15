import { createHash } from "node:crypto";
import { link, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

export class ConflictError extends Error {}
export class RetryableError extends Error {}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function manifestFingerprint(manifest) {
  return sha256(
    JSON.stringify({
      version: 1,
      chunks: manifest.chunks.map(({ index, byteSize, sha256 }) => ({
        index,
        byteSize,
        sha256,
      })),
      finalByteSize: manifest.finalByteSize,
      finalSha256: manifest.finalSha256,
    }),
  );
}

async function inTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function hashFile(path) {
  const digest = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
    byteSize += chunk.length;
  }
  return { byteSize, sha256: digest.digest("hex") };
}

export class LocalBlobStore {
  constructor(root) {
    this.root = resolve(root);
  }

  pathFor(key) {
    if (!/^(?:final|staging)\/[a-zA-Z0-9._/-]+$/.test(key)) {
      throw new Error(`invalid opaque blob key: ${key}`);
    }
    const path = resolve(this.root, key);
    if (!path.startsWith(`${this.root}${sep}`)) {
      throw new Error(`blob key escapes storage root: ${key}`);
    }
    return path;
  }

  async putImmutable(key, bytes) {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await hashFile(path);
      if (
        existing.byteSize !== bytes.length ||
        existing.sha256 !== sha256(bytes)
      ) {
        throw new ConflictError(`immutable blob conflict for ${key}`);
      }
    }
    return this.stat(key);
  }

  async finalizeChunks({
    chunks,
    expected,
    finalKey,
    failBeforeRename = false,
  }) {
    const finalPath = this.pathFor(finalKey);
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });

    try {
      const existing = await this.stat(finalKey);
      if (
        existing.byteSize !== expected.byteSize ||
        existing.sha256 !== expected.sha256
      ) {
        throw new ConflictError(
          `immutable final blob conflict for ${finalKey}`,
        );
      }
      return existing;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const temporaryPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
    const digest = createHash("sha256");
    let byteSize = 0;
    const output = createWriteStream(temporaryPath, {
      flags: "wx",
      mode: 0o600,
    });

    try {
      for (const chunk of chunks) {
        const stagedPath = this.pathFor(chunk.stagingKey);
        const actualChunk = await hashFile(stagedPath);
        if (
          actualChunk.byteSize !== Number(chunk.byteSize) ||
          actualChunk.sha256 !== chunk.sha256
        ) {
          throw new ConflictError(
            `staging chunk conflict at index ${chunk.index}`,
          );
        }
        await pipeline(
          createReadStream(stagedPath),
          async function* (source) {
            for await (const bytes of source) {
              digest.update(bytes);
              byteSize += bytes.length;
              yield bytes;
            }
          },
          output,
          { end: false },
        );
      }
      output.end();
      await new Promise((resolve, reject) => {
        output.once("finish", resolve);
        output.once("error", reject);
      });

      const actualSha256 = digest.digest("hex");
      if (byteSize !== expected.byteSize || actualSha256 !== expected.sha256) {
        throw new ConflictError(
          "final blob does not match the prepared manifest",
        );
      }
      if (failBeforeRename) throw new RetryableError("injected blob failure");

      // A hard-link publishes the complete inode atomically while preserving
      // create-if-absent semantics; rename(2) would replace an existing key.
      await link(temporaryPath, finalPath);
      await rm(temporaryPath);
      const directory = await open(dirname(finalPath), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return { key: finalKey, byteSize, sha256: actualSha256 };
    } catch (error) {
      output.destroy();
      await rm(temporaryPath, { force: true });
      if (error.code === "EEXIST") {
        const existing = await this.stat(finalKey);
        if (
          existing.byteSize === expected.byteSize &&
          existing.sha256 === expected.sha256
        ) {
          return existing;
        }
        throw new ConflictError(
          `immutable final blob conflict for ${finalKey}`,
        );
      }
      throw error;
    }
  }

  async stat(key) {
    const path = this.pathFor(key);
    const metadata = await stat(path);
    const hashed = await hashFile(path);
    return { key, ...hashed, modifiedAt: metadata.mtime };
  }

  async delete(key) {
    await rm(this.pathFor(key), { force: true });
  }

  async listFinal() {
    const root = this.pathFor("final/root").slice(0, -"/root".length);
    const objects = [];
    async function walk(directory) {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (!entry.name.endsWith(".tmp")) objects.push(path);
      }
    }
    await walk(root);
    return Promise.all(
      objects.map(async (path) => this.stat(relative(this.root, path))),
    );
  }
}

export async function installSchema(pool) {
  await pool.query(`
    CREATE TABLE recording_uploads (
      id text PRIMARY KEY,
      recording_id text NOT NULL UNIQUE,
      state text NOT NULL CHECK (state IN ('uploading', 'prepared', 'durable')),
      manifest_fingerprint text,
      final_blob_key text UNIQUE,
      final_sha256 text,
      final_byte_size bigint,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE recording_chunks (
      upload_id text NOT NULL REFERENCES recording_uploads(id),
      chunk_index integer NOT NULL CHECK (chunk_index >= 0),
      byte_size bigint NOT NULL CHECK (byte_size >= 0),
      sha256 text NOT NULL,
      staging_blob_key text NOT NULL UNIQUE,
      PRIMARY KEY (upload_id, chunk_index)
    );
    CREATE TABLE blob_sweep_candidates (
      blob_key text PRIMARY KEY,
      first_seen_at timestamptz NOT NULL,
      state text NOT NULL CHECK (state IN ('discovered', 'deleting'))
    );
  `);
}

export class FinalizationService {
  constructor(pool, blobStore) {
    this.pool = pool;
    this.blobStore = blobStore;
  }

  async createUpload({ uploadId, recordingId }) {
    const result = await this.pool.query(
      `INSERT INTO recording_uploads (id, recording_id, state)
       VALUES ($1, $2, 'uploading')
       ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
       RETURNING recording_id`,
      [uploadId, recordingId],
    );
    if (result.rows[0].recording_id !== recordingId) {
      throw new ConflictError("upload identity belongs to another recording");
    }
  }

  async addChunk(uploadId, index, bytes) {
    const stagingKey = `staging/${uploadId}/${index}.chunk`;
    const metadata = {
      byteSize: bytes.length,
      sha256: sha256(bytes),
      stagingKey,
    };
    return inTransaction(this.pool, async (client) => {
      const upload = await client.query(
        "SELECT state FROM recording_uploads WHERE id = $1 FOR UPDATE",
        [uploadId],
      );
      if (!upload.rowCount) throw new Error(`unknown upload ${uploadId}`);
      const existing = await client.query(
        `SELECT byte_size, sha256, staging_blob_key
           FROM recording_chunks WHERE upload_id = $1 AND chunk_index = $2`,
        [uploadId, index],
      );
      if (existing.rowCount) {
        const row = existing.rows[0];
        if (
          Number(row.byte_size) !== metadata.byteSize ||
          row.sha256 !== metadata.sha256 ||
          row.staging_blob_key !== stagingKey
        ) {
          throw new ConflictError(`chunk conflict at index ${index}`);
        }
        // An identical retry may restore a missing staging object even after
        // preparation, but it cannot alter the manifest-bound chunk metadata.
        await this.blobStore.putImmutable(stagingKey, bytes);
        return metadata;
      }
      if (upload.rows[0].state !== "uploading") {
        throw new ConflictError("new chunks are forbidden after preparation");
      }

      await this.blobStore.putImmutable(stagingKey, bytes);
      await client.query(
        `INSERT INTO recording_chunks
           (upload_id, chunk_index, byte_size, sha256, staging_blob_key)
         VALUES ($1, $2, $3, $4, $5)`,
        [uploadId, index, metadata.byteSize, metadata.sha256, stagingKey],
      );
      return metadata;
    });
  }

  async prepare(uploadId, manifest) {
    const fingerprint = manifestFingerprint(manifest);
    return inTransaction(this.pool, async (client) => {
      const uploadResult = await client.query(
        "SELECT * FROM recording_uploads WHERE id = $1 FOR UPDATE",
        [uploadId],
      );
      if (!uploadResult.rowCount) throw new Error(`unknown upload ${uploadId}`);
      const upload = uploadResult.rows[0];

      if (upload.state !== "uploading") {
        if (upload.manifest_fingerprint !== fingerprint) {
          throw new ConflictError("a different manifest is already prepared");
        }
        return upload;
      }

      const chunks = (
        await client.query(
          `SELECT chunk_index, byte_size, sha256, staging_blob_key
             FROM recording_chunks WHERE upload_id = $1 ORDER BY chunk_index`,
          [uploadId],
        )
      ).rows;
      if (chunks.length !== manifest.chunks.length) {
        throw new ConflictError(
          "manifest does not contain every accepted chunk",
        );
      }
      for (let index = 0; index < chunks.length; index += 1) {
        const stored = chunks[index];
        const declared = manifest.chunks[index];
        if (
          declared.index !== index ||
          stored.chunk_index !== index ||
          Number(stored.byte_size) !== declared.byteSize ||
          stored.sha256 !== declared.sha256
        ) {
          throw new ConflictError(`manifest conflict at chunk ${index}`);
        }
      }
      const declaredBytes = manifest.chunks.reduce(
        (total, chunk) => total + chunk.byteSize,
        0,
      );
      if (declaredBytes !== manifest.finalByteSize) {
        throw new ConflictError("manifest final byte size is inconsistent");
      }

      const finalKey = `final/${upload.recording_id}/original.audio`;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [finalKey],
      );
      const candidate = await client.query(
        "SELECT state FROM blob_sweep_candidates WHERE blob_key = $1 FOR UPDATE",
        [finalKey],
      );
      if (candidate.rows[0]?.state === "deleting") {
        throw new RetryableError("orphan sweeper is deleting this key");
      }
      await client.query(
        "DELETE FROM blob_sweep_candidates WHERE blob_key = $1",
        [finalKey],
      );

      const updated = await client.query(
        `UPDATE recording_uploads
            SET state = 'prepared', manifest_fingerprint = $2,
                final_blob_key = $3, final_sha256 = $4,
                final_byte_size = $5, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [
          uploadId,
          fingerprint,
          finalKey,
          manifest.finalSha256,
          manifest.finalByteSize,
        ],
      );
      return updated.rows[0];
    });
  }

  async finalize(uploadId, manifest, faults = {}) {
    const prepared = await this.prepare(uploadId, manifest);
    if (prepared.state === "durable") return prepared;

    const chunks = (
      await this.pool.query(
        `SELECT chunk_index AS index, byte_size AS "byteSize", sha256,
                staging_blob_key AS "stagingKey"
           FROM recording_chunks WHERE upload_id = $1 ORDER BY chunk_index`,
        [uploadId],
      )
    ).rows;
    const blob = await this.blobStore.finalizeChunks({
      chunks,
      expected: {
        byteSize: Number(prepared.final_byte_size),
        sha256: prepared.final_sha256,
      },
      finalKey: prepared.final_blob_key,
      failBeforeRename: faults.failBlobBeforeRename,
    });

    return inTransaction(this.pool, async (client) => {
      const current = (
        await client.query(
          "SELECT * FROM recording_uploads WHERE id = $1 FOR UPDATE",
          [uploadId],
        )
      ).rows[0];
      if (
        current.manifest_fingerprint !== manifestFingerprint(manifest) ||
        current.final_blob_key !== blob.key ||
        current.final_sha256 !== blob.sha256 ||
        Number(current.final_byte_size) !== blob.byteSize
      ) {
        throw new ConflictError("blob metadata does not match prepared state");
      }
      if (current.state === "durable") return current;
      const durable = (
        await client.query(
          `UPDATE recording_uploads SET state = 'durable', updated_at = now()
            WHERE id = $1 AND state = 'prepared' RETURNING *`,
          [uploadId],
        )
      ).rows[0];
      if (faults.failDatabaseConfirmation) {
        throw new RetryableError("injected database confirmation failure");
      }
      return durable;
    });
  }

  async discoverOrphans(now) {
    for (const blob of await this.blobStore.listFinal()) {
      await inTransaction(this.pool, async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [blob.key],
        );
        const referenced = await client.query(
          "SELECT 1 FROM recording_uploads WHERE final_blob_key = $1",
          [blob.key],
        );
        if (referenced.rowCount) {
          await client.query(
            "DELETE FROM blob_sweep_candidates WHERE blob_key = $1",
            [blob.key],
          );
        } else {
          await client.query(
            `INSERT INTO blob_sweep_candidates (blob_key, first_seen_at, state)
             VALUES ($1, $2, 'discovered') ON CONFLICT (blob_key) DO NOTHING`,
            [blob.key, now],
          );
        }
      });
    }
  }

  async sweepOrphans(discoveredBefore) {
    const candidates = await this.pool.query(
      `SELECT blob_key FROM blob_sweep_candidates
        WHERE (state = 'discovered' AND first_seen_at <= $1)
           OR state = 'deleting'
        ORDER BY blob_key`,
      [discoveredBefore],
    );
    const deleted = [];
    for (const { blob_key: blobKey } of candidates.rows) {
      const client = await this.pool.connect();
      try {
        await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
          blobKey,
        ]);
        await client.query("BEGIN");
        let claimed;
        try {
          const referenced = await client.query(
            "SELECT 1 FROM recording_uploads WHERE final_blob_key = $1",
            [blobKey],
          );
          if (referenced.rowCount) {
            await client.query(
              "DELETE FROM blob_sweep_candidates WHERE blob_key = $1",
              [blobKey],
            );
            claimed = false;
          } else {
            const result = await client.query(
              `UPDATE blob_sweep_candidates SET state = 'deleting'
                WHERE blob_key = $1 RETURNING blob_key`,
              [blobKey],
            );
            claimed = Boolean(result.rowCount);
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
        if (!claimed) continue;
        await this.blobStore.delete(blobKey);
        await client.query(
          "DELETE FROM blob_sweep_candidates WHERE blob_key = $1",
          [blobKey],
        );
        deleted.push(blobKey);
      } finally {
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
          [blobKey],
        );
        client.release();
      }
    }
    return deleted;
  }
}

export function createManifest(chunks) {
  const bytes = Buffer.concat(chunks);
  return {
    chunks: chunks.map((chunk, index) => ({
      index,
      byteSize: chunk.length,
      sha256: sha256(chunk),
    })),
    finalByteSize: bytes.length,
    finalSha256: sha256(bytes),
  };
}
