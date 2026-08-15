# Audio finalization spike

This executable spike proves the recovery protocol selected by ADR-0008 for
the non-atomic boundary between PostgreSQL and immutable blob storage. It uses
a real PostgreSQL 17.6 container and a streaming local-filesystem blob adapter.

## Run

Prerequisites are Node.js 22.22 or newer and a running Docker daemon. The test
starts an isolated PostgreSQL container and removes it afterward.

```sh
cd spikes/audio-finalization
npm ci
npm test
```

The suite injects a blob failure after database preparation, injects a database
rollback after the final blob has been atomically renamed, retries both cases,
rejects conflicting chunks/manifests/final blobs, and proves that two-pass
orphan sweeping deletes only aged and still-unreferenced final objects.

The implementation is deliberately spike-local. Phase 3 tasks will put the
protocol behind the production `BlobStore`, repositories, and API contracts.
