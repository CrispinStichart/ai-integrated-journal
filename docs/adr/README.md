# Architecture decision records

Architecture decision records (ADRs) capture consequential implementation choices that constrain later work. The governing product specification, mandatory high-level technical overview, and technical specification outrank these records in that precedence order.

## Statuses

- **Proposed:** under review and not yet binding.
- **Accepted:** binding for implementation until superseded.
- **Superseded:** retained for history and replaced by another ADR.
- **Rejected:** considered but not selected.

Changing an accepted decision requires a new ADR that identifies the record it supersedes. Existing records are never rewritten to disguise a past decision; minor clarifications that do not change the decision may be appended with a dated amendment.

## Index

| ADR                                                     | Status   | Decision                                                          |
| ------------------------------------------------------- | -------- | ----------------------------------------------------------------- |
| [0001](0001-stable-identities-and-package-ownership.md) | Accepted | Stable identities and package ownership                           |
| [0002](0002-api-versioning-and-compatibility.md)        | Accepted | API versioning and compatibility                                  |
| [0003](0003-semantic-value-serialization.md)            | Accepted | Semantic-value serialization                                      |
| [0004](0004-manual-and-generated-authority.md)          | Accepted | Manual and generated authority                                    |
| [0005](0005-processor-dependencies-and-versioning.md)   | Accepted | Processor dependencies and versioning                             |
| [0006](0006-first-usable-release-boundary.md)           | Accepted | First usable release boundary                                     |
| [0007](0007-atomic-queue-job-insertion.md)              | Accepted | Atomic queue job insertion through Drizzle                        |
| [0008](0008-recoverable-audio-finalization.md)          | Accepted | Recoverable audio finalization across PostgreSQL and blob storage |
| [0009](0009-privacy-evidence-and-retention-defaults.md) | Accepted | Privacy, evidence, retention, and local backup defaults           |
| [0010](0010-recording-resource-policy.md)               | Accepted | Bounded resources per operation, not per recording                |
