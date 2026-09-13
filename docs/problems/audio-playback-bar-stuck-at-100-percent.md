# Audio playback bar stuck at 100 percent

## Status

Investigation is complete. Implementation is intentionally split into two independently reviewable work units:

1. Vendor and modernize `webm-duration-fix` without changing application behavior.
2. Use the validated vendored package to repair WebM recordings and fix playback.

Each work unit should be validated and committed separately. The second must not begin until the first has established equivalent behavior, documented licensing, and adequate test coverage.

## Problem and root cause

Audio captured by Chromium's `MediaRecorder` is stored as Opus in a streaming WebM container. The encoded audio is finite, and the application records a finite wall-clock duration, but the produced WebM can contain an unknown-size Segment, a zero Duration element, and no Cues index. The browser therefore treats the recording like an unbounded stream: `HTMLMediaElement.duration` is `Infinity`, native controls show only elapsed time, and the playhead remains at the live edge, visually at 100 percent.

This is a container-metadata problem, not an audio encoding, upload, database-duration, or UI progress-calculation problem. The database's duration is useful application metadata, but native `<audio controls>` derives duration and seekability from the media resource itself.

The investigation confirmed this with an affected recording:

- The database duration was 20,818 ms.
- The WebM had a zero Duration element, an unknown-size Segment, and no Cues.
- Chromium exposed its duration as `Infinity` even when the API returned the complete file with the correct `Content-Length`.
- Repairing the container produced a finite duration of about 20.8 seconds without re-encoding the Opus audio.

The behavior originates in the WebM-first MIME selection and timesliced `MediaRecorder` capture in [`capture-controller.ts`](../../apps/web/src/recording/capture-controller.ts). There is also a related delivery issue in [`recording-routes.ts`](../../apps/api/src/recording-routes.ts): an open-ended range for a recording larger than `MAX_AUDIO_RANGE_BYTES` is rejected instead of being served as a bounded partial response. That issue does not cause the reproduced 20-second failure, but it must be handled for reliable playback and legacy repair of longer recordings.

## Decision

Vendor the implementation from `webm-duration-fix` v1.0.4, currently represented by upstream commit `87a71bf304c8cb4fbf19248ed5663e6aff9524ac`, into a private workspace package. First preserve and characterize its behavior, then update it to this repository's TypeScript, module, lint, and test standards. In a separate work unit, use it client-side to finalize WebM container metadata before durable upload and to provide a compatibility path for existing affected recordings.

The repair applies only to WebM. Ogg, MP4, or another browser-selected format must pass through unchanged. Opus frames must never be transcoded. The duration written to the WebM should be calculated from the encoded block timeline, which is the playback authority, rather than copied from the wall-clock duration stored by the application.

### Why this route was chosen

- It directly repairs the malformed or incomplete WebM metadata that native media controls consume, so duration and seeking work without replacing accessible native controls with a custom approximation.
- It performs a client-side remux only: encoded Opus data is retained, avoiding quality loss, server processing, and a second audio-codec pipeline.
- It is narrowly matched to the observed `MediaRecorder` output. Although the upstream package is old and small, its algorithm repaired the real affected recording during investigation.
- Vendoring removes dependence on an effectively unmaintained release and lets us bring the code under the repository's strict TypeScript checks, security limits, tests, and review process.
- A broad media framework such as Mediabunny is active and capable, but introduces a much larger and faster-moving API surface than this single-purpose fix needs.
- `ffmpeg.wasm` is mature at the engine level but its large WebAssembly payload, worker setup, virtual filesystem, memory use, and licensing considerations are disproportionate for a metadata-only repair. LibAV-based browser options have similar integration costs and a smaller user base.
- Lower-level EBML libraries such as `ts-ebml` would still leave us responsible for designing and maintaining the duration-rewrite algorithm. `webm-duration-fix` already packages that algorithm and can be made maintainable through characterization and modernization.
- The similarly named `@fix-webm-duration/fix` was tested against the affected file and did not repair its zero duration, so it is not a viable drop-in substitute for this case.
- Changing recording format is not a universal answer. WebM is available in current major browsers, while the existing capture fallback to Ogg or the browser default is still needed for differing and older implementations. The repair can safely be gated to WebM instead of adding a new format mandate.

## Non-goals

- Re-encoding or transcoding audio.
- Applying WebM logic to Ogg, MP4, or unknown formats.
- Replacing native audio controls merely to disguise an infinite duration.
- Mutating already-durable recording objects in place; durable recordings are immutable by design.
- Turning the vendored package into a general-purpose media toolkit.
- Checking a user's private recording into the repository as a fixture.
- Uploading the original malformed WebM silently if finalization fails.

## Work unit 1: vendor and modernize the library

This unit creates a tested internal package but does not add it to the web application's capture, sync, or playback flows.

### 1. Establish provenance and licensing

- Snapshot upstream v1.0.4 at commit `87a71bf304c8cb4fbf19248ed5663e6aff9524ac`; record the repository URL, tag, commit, retrieval date, and which files were imported.
- License the vendored fork and our modifications under MIT. ISC is permissive and MIT-compatible, so the npm manifest's ISC declaration does not prevent that choice.
- Preserve the original copyright and permission notices that apply to the imported source. Record that the GitHub repository contains an MIT license while the published npm manifest declares ISC and omits a license file; retain both upstream license records with the provenance documentation rather than erasing the discrepancy.
- Document all deliberate differences from upstream so later audits and upgrades can distinguish imported code from local changes.

### 2. Create an isolated workspace package

- Add a private package such as `packages/webm-duration-fix` with the repository's standard package layout, build configuration, exports, linting, and tests.
- Expose a small typed API that accepts WebM bytes or a `Blob` and returns finalized WebM bytes or a `Blob`. Keep browser-specific adaptation at the boundary and container parsing in platform-neutral code.
- Do not make `apps/web` depend on the package in this unit. Its only consumers should be package tests and any temporary diagnostic harness.

### 3. Characterize the upstream behavior before refactoring

- Import the upstream source with only the changes required to build it in isolation.
- Create synthetic, non-private fixtures covering a streaming WebM with missing duration, an already-finalized WebM, multiple clusters, multi-byte EBML sizes, and malformed or truncated input.
- Add a sanitized regression fixture that has the same relevant container structure as the reproduced recording but contains generated audio or no identifying payload.
- Assert structural outcomes, not only file size: finite Duration, finalized Segment size where applicable, valid SeekHead/Cues references, preserved audio block payloads, preserved codec/sample metadata, and idempotent handling of an already-valid file.
- Run the original implementation against the fixtures and record golden outputs or semantic expectations. Because upstream has no test suite, these characterization tests are the baseline for proving modernization did not change behavior accidentally.

### 4. Modernize incrementally

- Replace the ES5/CommonJS, TypeScript 4.5-era build with the repository's ESM/NodeNext and strict TypeScript configuration.
- Replace TSLint-era patterns, deprecated `Buffer` constructors, implicit or broad `any`, loose equality, unsafe indexed access, mutable public state, and outdated event patterns.
- Prefer standard `Uint8Array`, `DataView`, `Blob`, and Web APIs. Remove Node polyfills and small legacy dependencies where straightforward; retain a dependency only when replacing it would expand risk or scope, and document that decision.
- Separate EBML parsing, metadata calculation, and encoding behind explicit types and bounded interfaces. Preserve unknown elements and encoded audio blocks byte-for-byte.
- Make failures explicit with typed errors for unsupported input, invalid EBML, numeric overflow, truncated data, and resource-limit violations.
- Keep each refactor small enough to run the characterization suite before proceeding.

### 5. Add resource and security boundaries

- Reject invalid element sizes, unsafe integer conversions, excessive nesting, impossible offsets, and truncated input deterministically.
- Define practical maximum input and metadata sizes based on the application's recording limits. Avoid unchecked allocation from sizes supplied by the file.
- Confirm that unknown EBML elements cannot cause infinite loops and that failure does not return a partially rewritten file as successful.
- Add fuzz/property tests for EBML variable-length integers and malformed element trees where practical.

### 6. Validate and deliver the unit

- Run package unit tests, type checking, linting, formatting, and production build.
- Compare the modernized output against the characterized upstream output and semantic assertions.
- Re-run a local-only diagnostic with the affected recording; record the result in test notes without retaining its bytes.
- Document the internal API, provenance, license, limitations, and how to update the vendored snapshot.
- Commit this work independently. At this point no recording or playback behavior should have changed.

## Work unit 2: use the vendored library to fix recording playback

This unit integrates only the package validated in work unit 1.

### 1. Finalize new recordings before durable upload

- Add a WebM finalization step at the sync boundary after capture has stopped and all encrypted local checkpoints are durable, but before upload finalization.
- Reconstruct and decrypt the complete local recording in order. Detect WebM using both the normalized MIME type and EBML signature; do not trust the MIME string alone.
- Run the vendored finalizer once over the complete WebM. Use its encoded block timeline for the container duration and preserve Opus payload bytes.
- Re-chunk the finalized bytes deterministically within `MAX_AUDIO_CHUNK_BYTES`, protect those chunks, and calculate upload hashes and the final manifest from the finalized representation.
- Keep the original encrypted local checkpoints until the server confirms the finalized upload is durable. This preserves crash recovery and prevents the repair step from weakening the current offline-first safety model.
- Pass non-WebM recordings through the existing sync path unchanged. Pass an already-valid WebM through without unnecessary rewriting when the package reports no repair is needed.
- If WebM finalization fails, surface a recoverable sync error and retain the local recording; do not mark the malformed representation durable.

### 2. Support already-durable affected recordings

- Because durable objects are immutable, do not overwrite existing uploads. On playback of an affected WebM, fetch the authenticated original in bounded ranges, assemble it client-side, and repair it ephemerally.
- Create an object URL from the repaired `Blob` for the native `<audio>` element. Revoke the URL whenever the recording changes, the view unmounts, playback preparation fails, or the user logs out.
- Keep decrypted and repaired bytes in memory only; do not add them to persistent browser caches or service-worker storage.
- Show a loading/preparation state because legacy repair requires downloading the complete recording before playback can begin. Preserve retry behavior and distinguish network, authentication, and invalid-media failures.
- If the memory and startup cost proves unacceptable for long recordings, design a separately authorized derived-playback-asset migration rather than mutating the immutable original. That is a follow-up, not part of this fix.

### 3. Correct range delivery for long recordings

- Update the recording route so no-range and open-ended requests larger than `MAX_AUDIO_RANGE_BYTES` return a valid bounded `206 Partial Content` response with correct `Content-Range`, `Content-Length`, and `Accept-Ranges` headers rather than rejection or an ambiguous partial `200`.
- Ensure the legacy client continues requesting subsequent bounded ranges until the declared total length is reached.
- Cover boundary cases: empty content, exactly the maximum range, one byte over it, suffix ranges, invalid ranges, and a recording spanning multiple requests.

### 4. Preserve failure and privacy guarantees

- Bound client memory and reject recordings beyond the supported repair size with a clear error rather than risking tab exhaustion.
- Make cancellation and cleanup reliable during navigation, logout, retry, and network interruption.
- Do not log media bytes, decrypted data, object URLs, or content-derived identifiers.
- Preserve authentication, authorization, CSRF, hash validation, idempotency, and immutable-finalization semantics in the existing upload and playback APIs.

### 5. Add integration and browser coverage

- Unit-test WebM detection, pass-through behavior, deterministic re-chunking, duration selection, cleanup, cancellation, and error mapping.
- Extend sync tests to prove finalized bytes and hashes are uploaded, original checkpoints remain until durable confirmation, retries are idempotent, and Ogg/default formats are unchanged.
- Extend API route tests for bounded multi-range retrieval and correct HTTP status and headers.
- Add playback tests for both a newly finalized recording and an already-durable zero-duration WebM. Assert a finite media duration, a meaningful total-length display, seeking, and a playhead that advances from zero to completion.
- Exercise current Chromium, Firefox, and WebKit browser projects. Include WebM capture/playback where supported and verify non-WebM pass-through in the fallback path.
- Manually verify the original affected recording locally without committing or logging private content.

### 6. Validate and deliver the unit

- Run affected package and application unit/integration tests, browser tests, type checking, linting, formatting, and production builds.
- Verify offline capture and crash recovery before upload, online synchronization, long-recording range retrieval, playback cleanup, and logout cleanup.
- Update operational or architecture documentation to describe client-side WebM finalization and the legacy full-download cost.
- Commit the application integration separately from the vendored-library unit.

## Completion criteria

- New WebM recordings contain finite, internally consistent duration and seek metadata before they become durable.
- Existing affected WebM recordings play through native controls with a finite total duration and working seek bar via the compatibility path.
- Ogg, MP4, unknown, and already-valid media are not corrupted or unnecessarily transformed.
- Encoded Opus blocks are byte-for-byte preserved; no audio is re-encoded.
- Failed repair never loses the recoverable local recording or finalizes a malformed upload.
- Long recordings are retrieved through valid bounded range responses.
- The vendored source has traceable provenance, preserved upstream notices, an MIT license for the fork, strict modern TypeScript, resource limits, and regression coverage.
