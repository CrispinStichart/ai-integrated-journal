# `webm-duration-fix` upstream characterization

This note records the behavior of the unmodernized v1.0.4 implementation at commit `87a71bf304c8cb4fbf19248ed5663e6aff9524ac`. The tests under `packages/webm-duration-fix/test` are the executable baseline for Task 4.

## Fixtures and expectations

All fixtures are synthetic. Their EBML structure and payload bytes are generated deterministically in `fixtures.ts`; no user media or content-derived identifier is retained.

| Fixture | Input structure | Characterized result |
| --- | --- | --- |
| Missing duration | One finite Cluster inside an unknown-size Segment, Opus track metadata, no Duration/SeekHead/Cues | Inserts one finite Duration of 40 timecode units plus valid SeekHead and Cues. |
| Multiple clusters | Two Clusters at timecodes 0 and 100 | Inserts one cue per Cluster and a Duration of 140; all encoded block payloads remain byte-identical. |
| Unknown-size clusters | Two consecutive unknown-size streaming Clusters | Recognizes the implicit Cluster boundary, inserts one cue per Cluster, and preserves both original Cluster byte ranges. |
| Multi-byte sizes | 140-byte CodecPrivate and 140/141-byte block payloads | Parses and rewrites multi-byte EBML sizes while preserving metadata and payloads. |
| Already finalized | The deterministic output of the multiple-cluster case | A second upstream pass is byte-identical to the first. |
| Malformed/truncated | Invalid zero element ID, and a valid stream truncated within its final SimpleBlock | The baseline rejected the malformed ID but rewrote the truncated tail. Task 4 intentionally replaces both outcomes with typed `invalid-ebml` and `truncated-data` failures; no partial rewrite is returned. |
| Opaque metadata | Generated Void data inside Info and a generated unrecognized level-one leaf | Task 4 preserves both encoded elements byte-for-byte while rewriting known seek metadata. |
| Sanitized regression | Zero Duration, unknown-size Segment, no SeekHead/Cues, three Clusters, generated non-recording payload, Opus metadata | Produces Duration 20,818, valid SeekHead/Cues, and preserved payload/codec/sample metadata. |

The sanitized regression output is also pinned byte-for-byte:

- SHA-256: `e5b1b1999272d04493de28326b30571ad50f78c6988db596d19036f9776b937d`

## Structural baseline

For every successful repair, the suite checks the decoded EBML tree rather than using file length as a proxy:

- Duration exists exactly once, is finite, and matches the encoded block timeline.
- SeekHead positions resolve to the actual Info, Tracks, and Cues offsets.
- CueClusterPosition values resolve to actual Cluster offsets, and CueTime values match Cluster timecodes.
- SimpleBlock frame payloads, CodecID, CodecPrivate, SamplingFrequency, and Channels are preserved.
- A second pass over upstream's finalized representation is byte-idempotent.

The upstream encoder always emits its fixed eight-byte unknown-size Segment marker, even after adding finite seek metadata. The characterization therefore asserts that exact behavior. There is no case in this upstream implementation where a finite Segment size is finalized; changing that is outside Task 3.

## Modernization result

The Task 4 implementation produces the same pinned SHA-256 and satisfies every structural baseline above. It intentionally differs only where the modernization contract is stricter: truncated data is rejected, opaque metadata is retained, failures are typed, and the API no longer exposes the legacy injected implementation. The original source-file hashes and license evidence remain in `PROVENANCE.md`; the quarantined source itself was removed after the baseline had been reproduced.
