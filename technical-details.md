This will be a monorepo containing the frontend, backend, deployment scripts, and whatever else.

The frontend will be a Typescript Vue project, using Daisy UI for the UI. There is a `daisyui` skill that you must use when doing frontend work.

The backend will be written in Typescript, using `express.js`. Share code between the frontend and backend wherever it makes sense.

For storage, the system will be architected to be able to easily switch storage backends. The final version will probably use Azure blob storage, but the initial version will save files locally.

The frontend can target the latest browser APIs, so long as they work on Firefox Mobile.

The frontend should take advantage of VueUse whenever possible, rather than rolling your own helpers.

Both the frontend and backend should take advantage of `lodash` (via the `lodash-es` package) wherever possible.
