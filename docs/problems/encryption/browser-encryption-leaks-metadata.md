# Browser encryption leaves sensitive metadata visible

## Problem

The offline journal encrypts journal payloads, pending mutation bodies, and recording chunk bytes, but a substantial amount of associated IndexedDB metadata remains unencrypted.

Visible fields include owner and stable IDs, mutation kind and state, journal dates, access and capture timestamps, byte sizes, MIME and codec information, recording duration, chunk counts and hashes, upload state, and synchronization errors.

The current README wording can be read as saying each complete cache record, pending mutation, and recording checkpoint is encrypted. More precisely, the content-bearing payload or chunk is encrypted while operational metadata needed for indexing and recovery remains visible.

## Security impact

An attacker who obtains the browser profile but not the local unlock secret cannot read journal text or audio. They can still infer when the owner wrote or recorded, which days contain cached activity, the approximate size and duration of recordings, and whether captures or synchronization failed.

This may be an acceptable local indexing tradeoff, but it should be an explicit part of the privacy model. Journaling activity metadata can itself be sensitive.

## Evidence

- `apps/web/src/journal/offline.ts` encrypts serialized journal and outbox payloads and recording chunk bytes.
- `apps/web/src/storage/indexed-db.ts` stores the indexing, lifecycle, timing, size, recording, and synchronization fields outside the ciphertext.
- Authenticated additional data protects selected metadata from silent reassignment during decryption, but AAD is authenticated rather than encrypted and therefore provides no confidentiality.

## Expected resolution

Document the exact metadata leakage and decide which fields are necessary while the journal is locked. Move privacy-sensitive fields inside encrypted manifests where feasible, leaving only the minimal identifiers and ordering information required to locate, bound, expire, or recover records.
