# Summary and accomplishment processors

Task 42 installs two independent immutable processor definitions. `summary`
produces at most one `narrative_summary` interpretation for a Journal Day.
`accomplishments` produces independently reconciled, calendar-scannable
`accomplishment` or `notable_event` bullets. Neither output contract can embed
the other representation.

Both processors treat journal text as untrusted data, use bounded data-only
structured generation, and require exact retained evidence for every generated
item. Narrative output records source-only tone and explicit unknown-value
handling. Generated bullets record the basis for significance and completion;
only source-explicit completion can be classified as an accomplishment.
Generated output always starts unpinned and cannot claim manual authority.

Each narrative uses the stable key `daily-narrative`. Each bullet uses an
event-identity key that is independent of wording, category, array position,
pin state, and source revision. This lets whole-day reconciliation update
generated candidates without conflating the narrative and bullet streams.

## Manual authority

The artifact API supports all required bullet actions:

- Correction creates an immutable manual overlay.
- Deletion creates an authoritative tombstone.
- `pin` writes a manual pin or unpin revision; generated reprocessing cannot
  clear it.
- `POST /api/v1/journal-days/{id}/artifacts` adds a bounded manual bullet under
  the accomplishments processor. User-added bullets start pinned, use the
  reserved `manual:accomplishment:*` identity namespace, and survive
  reprocessing even when no generated bullet matches them.

The UI presents narrative and bullets as separate labeled cards, keeps the
complete Journal Day list available, exposes exact evidence and processor
lineage for generated results, and explicitly states that user-added bullets do
not claim generated evidence. All mutations require authentication, CSRF when
session auth is configured, idempotency, and (for existing artifacts) a strong
ETag. Audits store identifiers, operation names, hashes, and counts only—not
summary or bullet text.
