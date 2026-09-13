# `webm-duration-fix` resource limits

The package performs a whole-file, in-memory repair and therefore has hard per-operation limits. It is not integrated into capture, upload, or playback in work unit 1, and these limits do not create an application-wide recording duration or durable-size policy. A future caller must retain the original recoverable recording when this optional operation cannot accept it.

| Resource | Hard limit | Application basis |
| --- | --: | --- |
| Input | 128 MiB | The browser storage policy's 128 MiB low-space floor. Blob size is checked before `arrayBuffer()` materializes the bytes. |
| Retained and generated metadata | 8 MiB | One `MAX_AUDIO_CHUNK_BYTES` transport unit. This includes the EBML header, Info, Tracks, retained non-Cluster level-one elements, and rewritten SeekHead/Cues. |
| EBML nesting | 32 levels | Valid WebM metadata is shallow; the bound prevents recursive parser stack exhaustion. |
| Parsed elements | 500,000 | Bounds parser objects and generated cue work even when hostile input uses minimal or zero-length elements. |

Callers may use `maximumInputBytes` and `maximumMetadataBytes` to impose smaller operation bounds. Values above the hard limits cannot raise them. Successful output allocation is bounded by the accepted input plus the metadata limit; file-declared element sizes are validated against the enclosing byte range before any data copy.

Unknown-size values are accepted only for known master-element IDs. Every parser iteration must consume an element header and advance, including zero-length opaque elements. Unknown-size Cluster scanning either advances to a structurally valid next element boundary or terminates at the enclosing boundary. Invalid sizes, unsafe integer arithmetic, impossible offsets, excessive structure, and truncation throw a typed `WebmFinalizeError`; an error returns no result and the caller-owned input is never mutated.

Property tests cover safe EBML size-VINT round trips, arbitrary VINT bytes and offsets, every truncation point in a synthetic WebM, arbitrary malformed byte trees, repeatable error classification, and preservation of input on failure. Fixed tests cover the configured enforcement paths and long runs of opaque zero-length elements.
