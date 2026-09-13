# Internal `webm-duration-fix` package

`@journal/webm-duration-fix` is a private workspace package for bounded, in-memory repair of WebM duration and seek metadata. The recording synchronization controller uses its byte API for new WebM captures before upload; package tests remain the direct characterization and security-boundary consumers.

## API

The package root exports two finalizers:

- `finalizeWebmBytes(input, options?)` accepts a `Uint8Array` and resolves to `{ bytes, changed }`. This is the platform-neutral API. Caller-owned input is never mutated; when the result is unchanged, `bytes` may be the original array.
- `finalizeWebmBlob(input, options?)` accepts a `Blob` and resolves to `{ blob, changed }`. It checks `Blob.size` before materializing the data and preserves a non-empty input MIME type, otherwise using `audio/webm`.
- `assertWebmContainer(input, options?)` validates that bytes are an EBML document whose document type is `webm` and that it has a Segment.

`options.maximumInputBytes` and `options.maximumMetadataBytes` may tighten but cannot raise the package hard limits. Failures derive from `WebmFinalizeError` and have one of the stable codes `unsupported-input`, `invalid-ebml`, `numeric-overflow`, `truncated-data`, or `resource-limit`. The concrete error classes and hard-limit constants are also exported from the package root. Callers must treat every failure as having produced no repaired file.

## Scope and limitations

- The package repairs an entire WebM in memory. It neither streams nor transcodes and does not accept Ogg, MP4, or arbitrary EBML containers.
- Duration is inferred from the encoded block timeline using the upstream algorithm characterized in `CHARACTERIZATION.md`; it is not copied from application wall-clock metadata.
- Encoded Cluster ranges, including audio block payloads, are copied verbatim. Known seek metadata is regenerated, while opaque metadata covered by the characterization suite is preserved.
- The output deliberately retains upstream's eight-byte unknown-size Segment marker. “Finalized” here means finite duration and consistent seek metadata, not conversion to a finite-size Segment.
- The implementation is narrowly tested against MediaRecorder-like WebM structures containing Info, Tracks, and at least one Cluster. It is not a general Matroska editor.
- Idempotence is guaranteed by the characterization suite for this package's deterministic finalized representation, not for every independently authored valid WebM.

The operative resource ceilings and caller responsibilities are documented in [`RESOURCE-LIMITS.md`](RESOURCE-LIMITS.md). Source origin, retained license records, all deliberate local differences, and the required update procedure are documented in [`PROVENANCE.md`](PROVENANCE.md). The fork and local changes are MIT-licensed; the original notice and the upstream GitHub-MIT/npm-ISC discrepancy are preserved rather than normalized away.

## Application integration

The web synchronization boundary requires both a normalized WebM MIME type and the EBML signature before calling `finalizeWebmBytes`. It reconstructs the ordered encrypted checkpoints only after capture has stopped, rejects WebM input over the package's 128 MiB hard limit, and uploads deterministic protected chunks of at most 8 MiB from the returned representation. The original recovery checkpoints remain in IndexedDB until server durability is confirmed. A finalization failure is visible and leaves those checkpoints available for a safe retry; non-WebM and unchanged WebM recordings remain on the incremental pass-through path.

This integration does not repair an already-durable object at playback time. Existing malformed recordings remain immutable and may still expose an infinite native duration. No full-download repair, repaired-media object URL, or persistent playback derivative is present.
