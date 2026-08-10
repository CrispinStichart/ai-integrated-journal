This file contains the high-level technical specifications that MUST be followed.

This will be a monorepo containing the frontend, backend, deployment scripts, and whatever else.

The frontend will be a Typescript Vue/Vite project, using Daisy UI for the UI. There is a `daisyui` skill that you must use when doing frontend work.

The backend will be written in Typescript, using `express.js`. Share code between the frontend and backend wherever it makes sense.

For storage, the system will be architected to be able to easily switch storage backends. The final version will probably use Azure blob storage, but the initial version will save files locally.

Deployment hasn't been decided on, so the initial version will be localhost only.

The frontend can target the latest browser APIs, so long as they work on Firefox Mobile.

The application should be a PWA. Offline features will be limited to adding journal entry audio or text, or viewing existing cached entries. It will not attempt any offline processing.

The frontend should take advantage of VueUse whenever possible, rather than rolling your own helpers.

Both the frontend and backend should take advantage of `lodash` (via the `lodash-es` package) wherever possible.

Good software engineering practices should always be used. Don't take shortcuts.

There will be no maximum file size or recording length for journal entries.

There should be comprehensive test coverage. Tests should reference the requirement IDs from the official specification where applicable.

UI Component testing will use Vitest. End-to-end testing will use Playwright.

Git pre-commit hooks will be used to ensure that linting, formatting, and tests pass.
