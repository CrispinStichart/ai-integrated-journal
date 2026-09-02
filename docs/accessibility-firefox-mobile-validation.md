# Accessibility and Firefox Mobile validation

Validation date: 2026-09-02

This report records task 54's reproducible checks. The automated browser target
was Playwright 1.62.1 with bundled Mozilla Firefox 153.0, using both its desktop
profile and a 360 × 740 viewport with touch events enabled. Reflow was checked
at 320 CSS pixels, equivalent to a 1280-pixel layout at 400% zoom. Synthetic
fixtures contain no private journal content.

## Results

| Domain | Automated evidence | Result and limits |
| --- | --- | --- |
| Keyboard | `playwright/task-54-mobile.spec.ts`; `apps/web/test/components.test.ts` | PASS: skip link order, Enter-operated mobile navigation, route focus, native modal behavior, and opener focus restoration. No application keyboard shortcuts exist. |
| Screen reader | Firefox role/name assertions, full-page axe, and component axe tests | PASS for landmarks, headings, names, status/alert semantics, and polite atomic announcements. Speech output with a real assistive technology is not automatable here; see the manual observation below. |
| WCAG 2.2 AA | Firefox axe in light and dark themes, 320px reflow, target sizing, and reduced-motion assertions | PASS with zero axe violations and no horizontal page overflow. Automated rules do not prove every cognitive or spoken presentation criterion. |
| Touch/mobile viewport | Firefox context with `hasTouch: true`; `Locator.tap()`; capture/navigation target measurements | PASS: primary paths work without hover or gesture-only actions; checked targets are at least the WCAG 2.2 AA 24 × 24 CSS-pixel minimum. |
| PWA installability | Manifest assertions, service-worker control, production build, and offline shell tests | PASS: standalone manifest, start URL, icons, controlled shell, and offline navigation are present. Firefox's browser install chrome remains a manual observation. |
| Microphone | `apps/web/test/capture-controller.test.ts` | PASS: permission request, denial, MIME negotiation, 5-second timeslice, encrypted checkpointing, stop, track release, and interruption/error states. OS permission chrome and hardware audio quality remain manual observations. |
| Suspension/resume | `apps/web/test/recording-sync.test.ts`, `apps/web/test/offline-journal.test.ts`, and Firefox offline/reconnect cycles | PASS: reconstruction resumes the same identities and missing checkpoints, concurrent resume is deduplicated, and reconnect/visible paths remain safe. Actual mobile process suspension remains a manual observation. |
| Service-worker update | `apps/web/test/pwa.test.ts` and Firefox PWA checks | PASS: update/offline/error lifecycle is surfaced, activation requests reload, and an update prompt is deferred while capture is recording or stopping. |
| Storage pressure | capture, offline-journal, recording API, and reliability fault tests | PASS: advisory low space evicts read cache first; quota/abort and server exhaustion are visible; committed prefixes remain; retry safety is explicit. Genuine browser quota exhaustion remains a manual observation. |
| Long session | 256 sequential capture checkpoints and three repeated Firefox offline/reconnect route cycles | PASS: ordered bounded checkpoints, one track release, stable focus, and no page errors. A many-hour hardware/resource soak remains a manual observation. |

The audit fixed four accessibility/reliability defects: the mobile drawer opener
was not keyboard-focusable, the hidden drawer checkbox leaked into the
accessibility tree, global announcements were outside a landmark, and a waiting
service-worker update could prompt during active microphone capture. Dialog
focus restoration and reduced-motion behavior were also made deterministic.

## Manual observations not executed

These procedures are intentionally recorded as **NOT RUN**. They require real
assistive technology, browser/OS chrome, hardware, process suspension, or
resource pressure that page automation cannot truthfully observe. They are
supplementary observations, not a physical-device completion gate.

1. Screen reader speech: in Firefox, run NVDA or Orca on desktop, or TalkBack on
   Android. Traverse landmarks and headings; open and close the navigation and a
   confirmation dialog; trigger a route change, validation error, offline status,
   and upload status. Confirm each control has one useful name, changes are
   announced once, dialog reading stays inside the modal, and focus returns to
   the opener.
2. Browser zoom/reflow: at a 1280 CSS-pixel-wide Firefox window, zoom to 200% and
   400%. Complete text and audio forms and open dialogs. Confirm content is not
   clipped, two-dimensional scrolling is unnecessary, and focused controls are
   not hidden by the sticky header or dock.
3. Installation chrome: from a clean Firefox profile on a secure origin, load
   the app online, inspect the manifest/service worker, use Firefox's available
   install/add-to-home-screen action, launch standalone, then launch offline.
   Confirm the name, icons, start URL, theme, and offline shell.
4. Microphone and interruption: grant, deny, and revoke microphone permission;
   start and stop capture; lock/background the device during several checkpoints;
   return after the OS suspends the browser. Confirm the microphone indicator and
   track stop, a visible permission failure, and recovery from the last locally
   saved checkpoint without a duplicate recording.
5. Update during capture: make a second production build available while a
   recording is active. Confirm no update dialog interrupts recording, stop and
   save, accept the deferred update, and verify reload into the new controlled
   version with pending local work intact.
6. Real quota pressure: use a disposable Firefox profile and synthetic audio.
   Reduce available storage until a checkpoint write fails. Confirm cached reads
   are evicted first, the exact committed prefix remains after restart, the error
   is visible, and freeing capacity permits an identity-preserving retry.
7. Extended soak: record synthetic room noise for at least four hours while
   periodically backgrounding, changing routes, and disconnecting/reconnecting.
   Record Firefox memory before/after each hour and confirm no duration cap,
   unbounded growth trend, duplicate upload, lost checkpoint, stuck microphone,
   or uncaught page error.

## Reproduction

Run every package-manager command through Corepack:

```sh
corepack pnpm vitest run apps/web/test/components.test.ts apps/web/test/pwa.test.ts apps/web/test/capture-controller.test.ts apps/web/test/offline-journal.test.ts apps/web/test/recording-sync.test.ts apps/web/test/recording-api.test.ts
corepack pnpm test:e2e
corepack pnpm validate
```

The final validation result and commit are recorded in the task handoff journal
after the complete repository gate finishes.
