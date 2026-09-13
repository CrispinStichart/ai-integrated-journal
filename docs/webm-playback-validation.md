# Work unit 2 WebM playback validation

Work unit 2 was validated on 2026-09-13 against application integration through commit `f0d8b6c` plus this delivery documentation. The retained scope finalizes new WebM captures before durable upload and provides bounded audio range responses. The proposed ephemeral repair of already-durable recordings was canceled, and its discarded full-download/object-URL design is not part of this release.

## Automated validation

The following commands completed successfully from the repository root:

| Check | Command | Result |
| --- | --- | --- |
| Affected unit and integration suites | `corepack pnpm exec vitest run packages/webm-duration-fix/test apps/web/test/recording-sync.test.ts apps/web/test/recording-api.test.ts apps/api/test/recording-routes.test.ts packages/observability/test/index.test.ts` | 7 files passed; 61 tests passed. |
| Browser projects and production web build | `corepack pnpm test:e2e` | 18 tests passed across Chromium, Firefox, WebKit, and the Firefox mobile-viewport project. The finalized-WebM and non-WebM playback cases passed in Chromium, Firefox, and WebKit. |
| Formatting | `corepack pnpm format:check` through `corepack pnpm validate` | All matched files passed Prettier checking. |
| Lint | `corepack pnpm lint` through `corepack pnpm validate` | Passed with zero warnings. |
| Package boundaries and generated API | `corepack pnpm boundaries` and `corepack pnpm openapi:check` through `corepack pnpm validate` | 13 workspace project boundaries passed; generated OpenAPI was current. |
| Type checking | `corepack pnpm typecheck` through `corepack pnpm validate` | All 13 applicable workspace projects passed. |
| Repository and operations checks | `corepack pnpm test:pre-commit` and `corepack pnpm test:operations` through `corepack pnpm validate` | 6 pre-commit tests and 6 operations tests passed. |
| Full unit/application suite | `corepack pnpm test` through `corepack pnpm validate` | 111 files passed; 633 tests passed. |
| Infrastructure integration suite | `corepack pnpm test:infrastructure` through `corepack pnpm validate` | 24 files passed; 83 tests passed. |
| Production builds | `corepack pnpm build` through `corepack pnpm validate` | All 13 applicable workspace project builds passed, including the web production/PWA build. |
| Full browser rerun | `corepack pnpm test:e2e` through `corepack pnpm validate` | 18 tests passed across all four configured projects. |

The complete `corepack pnpm validate` release gate passed. Expected test-environment warnings about unavailable jsdom canvas support, a PostgreSQL client deprecation, and intentionally unserved mocked API proxy requests did not fail their suites.

## Lifecycle evidence

| Required behavior | Evidence and result |
| --- | --- |
| Offline capture and crash recovery before upload | `apps/web/test/capture-controller.test.ts`, `apps/web/test/indexed-db.test.ts`, and `apps/web/test/recording-sync.test.ts` passed. The sync cases reconstruct an interrupted controller, reuse the same recording identity, upload only missing checkpoints, and retain the encrypted originals until durable confirmation. |
| Online synchronization | `apps/web/test/recording-sync.test.ts` and `apps/web/test/recording-api.test.ts` passed WebM detection, encoded-timeline finalization, deterministic re-chunking/hashes, accepted-index pagination, prepared-state retry, idempotency, and non-WebM/unchanged-WebM pass-through. |
| Long-range retrieval | `apps/api/test/recording-routes.test.ts` passed empty and exact-limit responses, one-byte-over bounded `206`, open-ended and suffix ranges, explicit ranges, invalid/oversized ranges, declared totals, and source-stream cancellation on disconnect. No full-download legacy repair client exists or is claimed. |
| Playback behavior and cleanup | `playwright/audio-playback.spec.ts` passed finite duration, total-length display, seeking, advancing playhead, and completion for a newly finalized WebM in Chromium, Firefox, and WebKit; each also passed the non-WebM fallback. Server playback stream cleanup on disconnect passed in the API route suite. There is no repaired object URL to revoke because the canceled compatibility path is absent. |
| Logout and interruption cleanup | `apps/web/test/recording-sync.test.ts` passed abort of stale authenticated requests, retry with a fresh cancellation scope, and retention of encrypted checkpoints. `apps/web/src/App.vue` awaits sync-session clearing before offline and authentication logout, so in-flight plaintext work is canceled before in-memory keys are discarded. |
| Failure and privacy guarantees | Finalization failure and oversize tests passed without upload finalization or checkpoint deletion. Checksum conflicts suppress unsafe retries. `packages/observability/test/index.test.ts` passed denial of media bytes, decrypted data, object URLs, and content-derived identifiers. |

## Scope decisions and limitations

- The already-durable compatibility work was explicitly canceled. No full-download repair, object URL helper, playback preparation state, or persistent derived asset is present. Existing malformed durable WebM objects may therefore continue to expose an infinite native duration.
- Client-side finalization intentionally materializes a complete new WebM and has a hard 128 MiB input ceiling. Its temporary memory cost is proportional to the input and output. Oversize input remains encrypted and recoverable locally but cannot become durable through this finalizer.
- The original private affected recording was unavailable and its diagnostic requirement was explicitly waived. No search for private bytes was performed during this unit and no private-media result is claimed. Synthetic fixtures and generated browser media provide the retained reproducible evidence.
- Validation exposed no implementation defect requiring a code change. Delivery changes are documentation corrections that align architecture, operations, completion criteria, and package usage with the shipped behavior.
