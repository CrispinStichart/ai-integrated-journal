# Requirement evaluation and nudges

Requirement evaluations bind a Journal Day to one exact immutable processor
version. Their durable states are `not_evaluated`, `satisfied`,
`insufficient_information`, `pending_user_response`, `dismissed`,
`not_applicable`, and `failed`.

Only an enabled processor configured as required with an enabled versioned
nudge policy is evaluated. A complete successful result with adequate explicit
information becomes satisfied. Explicit none counts as information; unknown or
an empty supported item collection does not. Partial, queued, running, and
canceled work stays not evaluated. Technical processor failure becomes failed
and is never eligible for a digest.

The hourly `nudges.digest` schedule reloads canonical rows and consolidates all
eligible evaluations for one Journal Day into one digest. An owner-scoped
transaction lock and database uniqueness constraints prevent concurrent runs
from duplicating it. Defaults are one notification per owner-local calendar day
and quiet hours from 21:00 through 08:00 in the owner's IANA timezone. A digest
created during quiet hours remains visible in-app but waits until the next local
delivery window. Quiet hours and daily limits are configurable under Processors.

Answer, defer, dismiss-for-day, and not-applicable actions require a session,
CSRF token, idempotency key, and strong digest ETag. Every action creates a
manual `nudge_response` contribution linked through `elicitingNudgeId`, plus a
content-free action row. Answer and not-applicable resolve one exact evaluation;
dismiss resolves every item in that Journal Day digest and prevents another
default digest for it; defer retains pending state and schedules a later
delivery. Manual terminal resolutions are not overwritten by later processor
runs.

The API exposes:

- `GET /api/v1/nudges?journalDate=YYYY-MM-DD`
- `POST /api/v1/nudges/{digestId}/actions`
- `GET /api/v1/nudges/preferences`
- `PUT /api/v1/nudges/preferences`

Nudge mutations emit the content-free `nudge.updated` SSE event. The Journal
Day UI also retains normal query polling/refetch behavior as a fallback. No
nudge evaluation runs offline.
