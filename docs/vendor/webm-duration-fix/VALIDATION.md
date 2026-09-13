# Work unit 1 validation

Work unit 1 was validated on 2026-09-13 at commit `ab8f238` plus this delivery documentation. No application integration is included.

## Automated validation

The following commands completed successfully from the repository root:

| Check | Command | Result |
| --- | --- | --- |
| Package unit tests | `corepack pnpm --filter @journal/webm-duration-fix test` | 3 files passed; 23 tests passed. |
| Type checking | `corepack pnpm --filter @journal/webm-duration-fix typecheck` | Passed with the package's strict TypeScript configuration. |
| Lint | `corepack pnpm --filter @journal/webm-duration-fix lint` | Passed with zero warnings. |
| Format | `corepack pnpm exec prettier --check packages/webm-duration-fix docs/vendor/webm-duration-fix` | All matched files used Prettier formatting. |
| Production build | `corepack pnpm --filter @journal/webm-duration-fix build` | Passed; ESM JavaScript, declarations, and source maps were emitted to `dist`. |

The unit suite executes the upstream-characterization comparison rather than using build success as an equivalence proxy. The modern implementation matched the pinned sanitized-regression SHA-256 `e5b1b1999272d04493de28326b30571ad50f78c6988db596d19036f9776b937d` and the characterized semantic expectations: finite encoded-timeline Duration, resolvable SeekHead and Cues offsets, byte-preserved Cluster/audio payloads and codec/sample metadata, multi-cluster and multi-byte-size handling, preservation of characterized opaque metadata, and byte-idempotence of the deterministic finalized representation. The deliberate typed rejection of malformed and truncated input is also covered. Resource-boundary and property tests cover VINT handling, truncation points, malformed trees, stable error classification, input preservation on failure, nesting, element count, and size limits.

## Original affected-recording diagnostic

The original private recording was not available in permitted local workspace paths, so its diagnostic was not rerun and no result is claimed. The workspace search found no file with a media extension and no file with the EBML signature `1a45dfa3`; the signature check inspected 26,900 non-dependency, non-generated-report files without printing filenames or media content. No recording bytes were present to retain or log. The synthetic sanitized regression remains the reproducible non-private analogue; it records the expected 20,818-unit Duration without containing user media.

If the private bytes are made available for a later local validation, run the byte finalizer in a temporary, ignored harness, verify a finite duration and seek metadata plus byte-identical encoded audio blocks, record only those non-sensitive outcomes here, and delete any temporary output and harness. Leave the authorized original location untouched. Never commit filenames, content-derived identifiers, hashes, or media bytes.

## Delivery boundary

The Work unit 1 commit range does not modify `apps/web` or `apps/api`. `apps/web/package.json` is unchanged and has no dependency on this package; the lockfile contains only an empty workspace importer for `packages/webm-duration-fix`. Consequently capture, synchronization, upload, range delivery, and playback behavior remain unchanged. Application use of the package, including any dependency or behavior change, belongs exclusively to Work unit 2.
