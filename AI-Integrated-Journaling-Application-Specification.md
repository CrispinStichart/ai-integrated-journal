# AI-Integrated Journaling Application — Product and System Specification

**Status:** Draft baseline specification  
**Version:** 1.0  
**Date:** 2026-08-09  
**Scope:** Functional requirements and conceptual architecture

## 1. Purpose

This document specifies a private, AI-integrated journaling application that makes daily capture easy while preserving the user's original record and producing useful, reviewable structured information. The application supports typed and recorded contributions, durable audio and transcript history, configurable AI processors, corrective memory, nudges for missing information, search, and long-term data portability.

The central architectural principle is:

> **Sources are the durable record; observations are traceable claims extracted from sources; interpretations are revisable conclusions derived from observations.**

AI output is never the sole canonical record of what the user said or did. Derived information remains attributable, versioned, correctable, and reproducible.

## 2. Normative language

The terms **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative:

- **SHALL / SHALL NOT** indicate mandatory behavior.
- **SHOULD / SHOULD NOT** indicate a strong recommendation that may be departed from only for a documented reason.
- **MAY** indicates optional behavior.

Requirement identifiers are stable. Removing a requirement shall not cause its identifier to be reused.

## 3. Goals

- Make it fast and safe to journal through text or speech at any time.
- Preserve original evidence independently of later AI processing.
- Turn free-form journal material into useful, semi-structured observations without forcing the user into rigid forms.
- Support configurable processors that can evolve without redesigning the journal.
- Learn from corrections while keeping all persistent memory and behavioral rules visible and controllable.
- Distinguish missing information from neutral, zero, negative, or not-applicable values.
- Allow historical analysis, reprocessing, search, and export without losing provenance.
- Remain independent of any particular model provider or implementation platform.

## 4. Scope and non-goals

### 4.1 In scope

- A single private user's journal, organized by journal date.
- Multiple typed and recorded contributions per day.
- Audio preservation, transcription, correction, cleanup, and traceable AI processing.
- Generic configurable processors, including initial food, mood, sleep, tasks/intentions, summaries, and accomplishments processors.
- User corrections, feedback, memories, known entities, and processing rules.
- Required-information nudges.
- Full-text and semantic retrieval.
- Privacy, retention, backup, export, deletion, and recovery requirements.

### 4.2 Non-goals

- This specification does not prescribe a programming language, framework, cloud, database, model, or provider.
- It does not define clinical, nutritional, or mental-health diagnosis.
- It does not require social networking, publication, or multi-user collaboration.
- It does not define a complete task manager, calorie tracker, or medical record system. Integrations may extend the application, but the journal remains useful without them.
- It does not require AI to infer facts absent from the user's record or to manufacture numerical precision.

## 5. Definitions

| Term                     | Definition                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Journal Day**          | A date-keyed container that groups contributions and results. It is not a single monolithic entry.                                        |
| **Contribution**         | A discrete item added to a Journal Day, such as typed text, a recording, or a nudge response.                                             |
| **Source**               | User-authored or captured primary material: audio, raw STT, corrected transcript, cleaned transcript, typed text, or explicit user input. |
| **Raw STT**              | The immutable response returned by a speech-to-text operation, including available timing and metadata.                                   |
| **Corrected Transcript** | A user-correctable representation of what was actually said, without intentional stylistic rewriting.                                     |
| **Cleaned Transcript**   | A derived, readable representation with disfluencies and accidental repetition removed while preserving meaning.                          |
| **Observation**          | A bounded, source-supported claim, such as a consumption event or a mood statement.                                                       |
| **Interpretation**       | A conclusion, aggregation, classification, rating, or summary derived from one or more observations or sources.                           |
| **Processor**            | A configurable rule-driven operation that extracts observations, produces interpretations, or performs another declared transformation.   |
| **Evidence Span**        | A reference to the precise source region supporting a result, optionally including audio time offsets.                                    |
| **Provenance**           | The record of source inputs, processor and prompt versions, model/provider, times, and user/AI authorship behind an artifact.             |
| **Memory**               | A visible persistent fact, vocabulary item, entity, alias, preference, or correction rule used to assist future processing.               |
| **Manual Override**      | A user-entered or user-corrected value that takes precedence over generated values.                                                       |
| **Stale**                | A derived artifact whose inputs or governing definition have changed since it was produced.                                               |
| **Journal Timezone**     | The default timezone used to assign journal dates and interpret relative temporal language.                                               |

## 6. Architectural principles

### 6.1 Source → observation → interpretation

**ARCH-001** The system SHALL organize information into three conceptual layers:

1. **Sources:** immutable captures and user-editable representations of those captures.
2. **Observations:** atomic or event-like facts extracted from sources, each with evidence and uncertainty.
3. **Interpretations:** summaries, aggregate ratings, trends, classifications, and other revisable conclusions.

**ARCH-002** An interpretation SHOULD depend on observations rather than directly on original audio when suitable observations already exist.

**ARCH-003** Each derived artifact SHALL identify its direct inputs so it can be invalidated or reproduced.

**ARCH-004** Human-authored and human-corrected data SHALL outrank generated data.

**ARCH-005** Failure of any AI stage SHALL NOT prevent source capture, viewing, editing, or later retry.

### 6.2 Conceptual flow

```text
Journal Day
  ├─ Contributions
  │    ├─ Typed text
  │    └─ Recording
  │         ├─ Immutable original audio
  │         ├─ Immutable raw STT
  │         ├─ Corrected transcript
  │         └─ Cleaned transcript
  ├─ Observations
  │    ├─ Food consumption events
  │    ├─ Mood observations
  │    ├─ Sleep events
  │    ├─ Tasks and intentions
  │    └─ Future observation types
  └─ Interpretations
       ├─ Daily mood aggregate
       ├─ Narrative summary
       ├─ Accomplishment/notable-event bullets
       └─ Future interpretation types
```

## 7. Conceptual data model

### 7.1 Journal Day

**DATA-001** A Journal Day SHALL be a date-addressable container that accepts zero or more contributions.

**DATA-002** The user SHALL be able to add to or edit any Journal Day, including past and future dates.

**DATA-003** The interface MAY present a Journal Day as one continuous narrative, but the system SHALL preserve contribution boundaries and individual provenance.

**DATA-004** A Journal Day SHALL have a stable identity independent of its presentation.

### 7.2 Contribution

**DATA-010** Every contribution SHALL record its creation time, effective journal date, source type, authorship, and applicable timezone.

**DATA-011** Contributions SHALL be independently addable, viewable, processable, and recoverable.

**DATA-012** Editing one contribution SHALL NOT require retranscribing unrelated recordings.

**DATA-013** A nudge response SHALL be stored as a contribution or equally durable explicit user input and SHALL retain the nudge that elicited it.

### 7.3 Source artifacts

**DATA-020** Each recording SHALL have a stable identity created before final upload or processing.

**DATA-021** Original audio SHALL be immutable after successful persistence. Replacement audio SHALL create a new source artifact rather than mutate the original.

**DATA-022** Raw STT output SHALL be immutable and preserved exactly as returned, subject only to an explicit retention/deletion action.

**DATA-023** Raw STT provenance SHALL include, where applicable: provider, model name/version, processing time, language, transcription context supplied, configuration parameters, and word/segment timestamps.

**DATA-024** Corrected transcripts SHALL be distinct from raw STT and SHALL represent corrections to what was said.

**DATA-025** Cleaned transcripts SHALL be derived from the corrected transcript and SHALL preserve semantic meaning while allowing removal of filler words, false starts, and accidental repetition.

**DATA-026** The system SHALL retain revision history or equivalent auditability for user-editable transcripts and typed text.

**DATA-027** Available transcript timestamps SHALL be retained and SHOULD permit navigation from text to the corresponding audio region.

**DATA-028** If timestamps are unavailable, the result SHALL remain valid and the absence SHALL be represented as unknown, not as a failure.

### 7.4 Processor definition and result

**DATA-030** A Processor definition SHALL include a stable identity, name, purpose, enabled state, requirement mode, instructions, input scope, output contract, current definition version, and nudge behavior where applicable.

**DATA-031** Processor results SHALL use a common envelope with at least:

- stable result identity;
- processor identity and definition version;
- target Journal Day or source scope;
- lifecycle/status;
- extensible processor-specific payload;
- zero or more evidence spans and source references;
- model/provider and prompt/instruction version information;
- creation and update times;
- confidence or uncertainty when meaningful;
- authorship and manual-modification status;
- direct input versions;
- supersession and staleness state.

**DATA-032** Processor-specific payloads SHALL be extensible and semi-structured. Processors MAY evolve independently without changing the common envelope.

**DATA-033** Unknown optional fields SHALL be omitted or explicitly marked unknown. They SHALL NOT be populated with invented values.

### 7.5 Evidence and provenance

**PROV-001** Every AI-created observation SHOULD cite at least one evidence span unless the processor explicitly produces a result that cannot reasonably be span-grounded.

**PROV-002** AI-created interpretations SHALL identify the observations and/or source artifacts from which they were derived.

**PROV-003** Evidence references SHALL survive ordinary editing where feasible; if a referenced span can no longer be resolved, the result SHALL be marked stale or its evidence marked unresolved.

**PROV-004** The user SHALL be able to inspect why a result exists, including its evidence, processor version, model/provider, and whether it was later corrected.

## 8. Capture, recording, and transcription

**CAP-001** The user SHALL be able to create multiple recordings and typed contributions for the same Journal Day.

**CAP-002** A recording SHALL first be retained in a recoverable local or equivalent pre-upload state until durable persistence is confirmed.

**CAP-003** Interrupted upload, loss of connectivity, application suspension, or page closure SHALL NOT silently discard an unconfirmed recording.

**CAP-004** Upload and processing retries SHALL be idempotent and SHALL NOT create duplicate recordings or contributions.

**CAP-005** Long recordings SHOULD be checkpointed or otherwise protected so that a late interruption does not destroy the entire capture.

**CAP-006** The system SHALL visibly distinguish recording, locally saved, uploading, durably saved, transcription pending, and failed states as applicable.

**CAP-007** The user SHALL be able to assign a recording to a Journal Day different from its capture date, including “yesterday.”

**STT-001** Once audio is durably saved, transcription MAY proceed asynchronously.

**STT-002** Transcription failure SHALL preserve the recording and expose a retry action.

**STT-003** The system SHALL support global transcription context assembled from user-approved memories, known entities, terms, aliases, and correction rules.

**STT-004** The exact effective transcription context used for a run SHALL be recorded in provenance or reconstructable from immutable version references.

**STT-005** The architecture MAY later support day- or contribution-specific context, but global context is the baseline requirement.

## 9. Correction, memory, and universal feedback

**MEM-001** The system SHALL distinguish “correct this occurrence” from “correct and remember.”

**MEM-002** Ordinary transcript edits SHALL NOT automatically become global correction rules.

**MEM-003** The system MAY suggest remembered corrections for names, places, acronyms, jargon, and recurring vocabulary, but user approval SHOULD be required before global activation.

**MEM-004** All active memories and rules SHALL be visible, searchable, editable, disableable, and deletable by the user.

**MEM-005** Each memory SHALL record its content, type, source or rationale, creator (user or AI), approval state, applicable scope, and revision history.

**MEM-006** The system SHALL NOT maintain an inaccessible or unexplained profile or silently accumulate arbitrary behavioral prompt text.

**MEM-007** Suggested facts about the user or other people SHALL remain suggestions until approved, unless the user explicitly configures a different policy.

**FB-001** A universal feedback mechanism SHALL be available from transcripts, observations, interpretations, and processor results.

**FB-002** Feedback SHALL be classified into an explicit scope such as occurrence-only, processor rule, transcription context, known fact, or broader application preference.

**FB-003** Before or immediately after persistent application, the resulting rule or memory SHALL be shown to the user and remain manageable in the visible rules/memory area.

**FB-004** Ambiguous feedback SHALL default to the narrowest safe scope and SHALL NOT silently create a broad rule.

## 10. Processor framework

**PROC-001** Processors SHALL be first-class configurable objects rather than hard-coded assumptions tied to a single feature.

**PROC-002** The user SHALL be able to enable, disable, and configure processors and SHOULD be able to create new processors without changing the core application.

**PROC-003** A processor SHALL declare whether it extracts observations, produces interpretations, transforms sources, or performs another defined operation.

**PROC-004** A processor SHALL declare its input scope, such as a contribution, an entire Journal Day, a date range, existing observations, or another processor result.

**PROC-005** Processors operating on day-level event state SHALL consider the whole relevant day and support create, update, delete/supersede, and unchanged outcomes.

**PROC-006** Processor definitions, output contracts, prompts/instructions, and relevant behavior SHALL be versioned.

**PROC-007** Every result SHALL record the exact processor definition version and model/provider configuration that produced it.

**PROC-008** The system SHALL support future processor types and payload fields without invalidating existing results.

**PROC-009** A processor SHALL NOT convert absence of evidence into evidence of absence unless the source explicitly establishes the negative fact.

**PROC-010** A processor SHOULD express uncertainty and SHALL avoid fabricated precision.

### 10.1 Required, optional, and nudge states

**NUDGE-001** Each processor MAY be configured as required or optional for a Journal Day.

**NUDGE-002** Required-information evaluation SHALL support at least these semantic states:

- **Not evaluated** — processing has not completed;
- **Satisfied** — adequate information is present;
- **Insufficient information** — no adequate value can be established;
- **Pending user response** — a nudge awaits action;
- **Dismissed** — the user chose not to provide the information for this day;
- **Not applicable** — the requirement does not apply;
- **Failed** — the evaluation could not complete.

**NUDGE-003** Optional processors SHALL NOT generate missing-information nudges by default.

**NUDGE-004** Nudges SHALL be generated only after relevant processing has completed successfully enough to determine insufficiency.

**NUDGE-005** Multiple missing required items SHOULD be consolidated into a single digest and subject to configurable frequency and daily limits.

**NUDGE-006** A user SHALL be able to answer, defer, dismiss for the day, or mark not applicable where meaningful.

**NUDGE-007** A failed processor SHALL NOT be presented as though the user omitted information.

## 11. Value semantics: unknown is not zero

**SEM-001** The system SHALL distinguish at minimum: unknown/unmentioned, explicitly none/zero, neutral, not applicable, uncertain, and known value where those concepts apply.

**SEM-002** “Mood not mentioned” SHALL NOT become “neutral mood.”

**SEM-003** “Food not mentioned” SHALL NOT become “ate nothing.” Equivalent rules apply to caffeine, alcohol, sleep, exercise, tasks, and future domains.

**SEM-004** Statistics and summaries SHALL exclude or separately report unknown values rather than silently treating them as zero or neutral.

**SEM-005** User interfaces and exports SHALL preserve these distinctions.

## 12. Temporal semantics

**TIME-001** The system SHALL separately record capture time, journal date, and timezone.

**TIME-002** Journal-date assignment SHALL use a configured Journal Timezone by default and SHALL permit a manual override.

**TIME-003** Travel or timezone changes SHALL NOT silently reassign existing contributions to different Journal Days.

**TIME-004** Relative expressions such as “today,” “last night,” and “tomorrow” SHALL be resolved using the contribution's temporal context and effective journal date, not the later processing time.

**TIME-005** A resolved temporal value SHALL retain the original expression, resolution basis, timezone, and uncertainty.

**TIME-006** Ambiguous late-night language SHALL not be forced into calendar-date semantics without context. The selected interpretation SHALL be reviewable and correctable.

**TIME-007** A manual date/time correction SHALL outrank later automated resolution.

### 12.1 Sleep-date convention

**SLEEP-001** Nightly sleep SHALL be associated by default with the date on which the user woke, regardless of when sleep began.

**SLEEP-002** The application SHALL disclose this convention and permit correction of any sleep event's associated date.

**SLEEP-003** Naps and multiple sleep periods SHALL be represented as separate sleep events and SHALL NOT overwrite nightly sleep.

**SLEEP-004** Sleep observations MAY include reported quality, start/end or duration, interruptions, context, and subjective effects, but unknown fields SHALL remain unknown.

## 13. Initial processor semantics

### 13.1 Food and drink

**FOOD-001** The food processor SHALL extract consumption events, not merely food mentions.

**FOOD-002** Buying, planning, considering, cooking, or another person's consuming an item SHALL NOT be recorded as the user's consumption without supporting evidence.

**FOOD-003** Food observations MAY include description, meal/time of day, explicit time, quantity text, normalized quantity when confidently supported, location/context, food/drink classification, caffeine, alcohol, and notes.

**FOOD-004** Qualitative quantities such as “some” SHALL remain qualitative unless the source supplies sufficient precision.

**FOOD-005** Later clarifications SHALL update or supersede the same logical consumption event where appropriate rather than create a duplicate.

**FOOD-006** The processor SHALL evaluate the whole day's food state when reconciling additions and corrections.

**FOOD-007** The user SHALL be able to split, merge, correct, delete, or explicitly confirm consumption events.

### 13.2 Mood

**MOOD-001** The mood processor SHALL preserve individual mood observations, including applicable time period, context, valence or characterization, and evidence.

**MOOD-002** A daily overall mood rating SHALL be an interpretation derived from one or more observations, not a replacement for them.

**MOOD-003** Mixed or changing mood across the day SHALL be representable without collapsing the underlying observations.

**MOOD-004** An absent mood statement SHALL yield insufficient information, not a neutral rating.

**MOOD-005** User-entered aggregate ratings and observation corrections SHALL outrank generated values.

**MOOD-006** Mood output SHALL be framed as journaling analysis and SHALL NOT claim clinical diagnosis.

### 13.3 Tasks, intentions, and things to remember

**TASK-001** The processor SHALL distinguish completed actions from future obligations, firm intentions, tentative intentions, contemplation, suggestions by others, and general interests.

**TASK-002** A task-like observation SHOULD retain intention strength, description, status, due date when supported, original temporal phrase, and evidence.

**TASK-003** The system SHALL NOT automatically create an external task from contemplation or ambiguous desire without a user-approved policy or confirmation.

**TASK-004** The broader concept “Things to Remember” MAY include tasks, media recommendations, people to contact, places to visit, purchase ideas, and research topics.

**TASK-005** A statement that an action was completed SHALL not create a new pending task unless the source also expresses a future action.

### 13.4 Summaries and accomplishments

**SUM-001** The system SHOULD produce a concise narrative daily summary separately from a list of notable events and accomplishments.

**SUM-002** Summary bullets SHOULD be suitable for calendar scanning and SHALL retain links to supporting observations or source spans.

**SUM-003** Summary generation SHALL not silently invent significance, completion, or emotional tone.

**SUM-004** The user SHALL be able to edit, add, remove, and pin bullets; manual changes SHALL survive reprocessing.

**SUM-005** Calendar presentation MAY show a limited subset while preserving the full list within the Journal Day.

## 14. Editing, dependency, and reprocessing

**EDIT-001** Changes to a corrected transcript SHALL mark dependent cleaned transcripts, observations, and interpretations stale when their recorded inputs no longer match.

**EDIT-002** Changes to observations SHALL mark dependent interpretations stale without unnecessarily retranscribing audio.

**EDIT-003** The user SHALL be able to reprocess a contribution, Journal Day, selected date range, processor, or processor version.

**EDIT-004** Reprocessing SHALL be explicit and SHALL show its scope and expected effect before large historical runs.

**EDIT-005** Historical results SHOULD remain auditable through version history, supersession links, or snapshots rather than silent destructive replacement.

**EDIT-006** A manual correction or user-entered value SHALL NOT be overwritten by reprocessing.

**EDIT-007** When new generated output conflicts with a manual value, the system MAY present the difference for review but SHALL preserve the manual value as authoritative.

**EDIT-008** Processor-version changes SHALL not silently mix incompatible historical semantics in statistics. Reports SHALL either expose version differences or use an explicitly normalized/reprocessed dataset.

## 15. Processing lifecycle, failures, and retries

**STATE-001** Each processing stage SHALL have an independent visible lifecycle state, such as queued, running, succeeded, insufficient information, stale, failed, canceled, or superseded.

**STATE-002** A failure in cleanup or one processor SHALL NOT invalidate successful transcription or other processor results.

**STATE-003** Errors SHALL identify the affected stage and offer a safe retry when possible.

**STATE-004** Retries SHALL be idempotent or create an explicitly linked new attempt; they SHALL NOT silently duplicate observations.

**STATE-005** Partial results SHALL be labeled as partial and SHALL not masquerade as complete day-level analysis.

**STATE-006** Capture and durable storage SHALL have priority over optional AI processing.

**STATE-007** The user SHALL be able to use the journal while processing is pending or unavailable.

## 16. Search and retrieval

**SEARCH-001** The system SHALL provide deterministic full-text search across typed text and transcript layers the user chooses to include.

**SEARCH-002** The system SHOULD provide semantic retrieval over journal fragments, observations, summaries, and memories.

**SEARCH-003** Search results and generated answers SHALL link back to Journal Days and precise sources/evidence wherever possible.

**SEARCH-004** The interface SHALL clearly distinguish quoted/retrieved source content from AI-generated synthesis.

**SEARCH-005** Search SHOULD support filters such as date range, contribution type, processor, result type, people/entity, and manual/generated status.

**SEARCH-006** Retrieval SHALL honor all deletion, retention, and privacy rules; deleted audio or excluded private material SHALL not remain retrievable through stale indexes.

**SEARCH-007** A generated answer that lacks adequate supporting evidence SHALL say so rather than provide an unsupported recollection.

## 17. Audio retention and deletion

**RET-001** The default policy SHOULD retain original audio indefinitely unless the user chooses another policy.

**RET-002** Audio metadata SHOULD include duration, size, format/codec, checksum, capture time, and persistence status.

**RET-003** Audio retention SHALL be independently configurable from transcript and journal retention.

**RET-004** The user SHALL be able to delete audio while retaining transcripts, subject to a clear warning that audio verification and timestamp playback will no longer be available.

**RET-005** The user SHALL be able to delete an entire contribution or Journal Day, with clear disclosure of affected derived data and backups.

**RET-006** Material deletion SHOULD use a recoverable grace period where feasible, followed by documented permanent deletion behavior.

**RET-007** Derived artifacts, search indexes, caches, and exports under system control SHALL be updated consistently after deletion.

## 18. Privacy and security

**SEC-001** Journal content, audio, transcripts, observations, interpretations, memories, and credentials SHALL be private by default.

**SEC-002** The system SHALL require strong authentication and SHALL support secure session management. Network-level access restriction MAY be used as an additional control but SHALL NOT be treated as the sole protection unless the deployment is explicitly designed as isolated and the risk is accepted.

**SEC-003** Model and integration credentials SHALL be kept separate from journal content and SHALL never be exposed in client-visible logs or exports.

**SEC-004** The user SHALL be informed which provider receives which content for processing and SHALL be able to disable a provider or processor.

**SEC-005** The system SHOULD minimize content sent to external models to what is necessary for the declared operation.

**SEC-006** Provider data-retention/training implications SHALL be disclosed at configuration time where known.

**SEC-007** Logs and diagnostics SHALL avoid journal text and audio by default and SHALL use redaction where content is necessary for troubleshooting.

**SEC-008** Administrative and destructive actions SHALL be auditable.

**SEC-009** Memories about third parties SHALL receive the same privacy protections as journal content.

## 19. Backup, export, and portability

**PORT-001** The system SHALL support regular backups of all durable journal state, including metadata needed to reconstruct relationships and provenance.

**PORT-002** Backups SHALL have a documented retention policy and SHOULD support restoration testing.

**PORT-003** The user SHALL be able to export all journal data in documented, non-proprietary or widely readable formats.

**PORT-004** A complete export SHALL include original audio when selected, typed text, transcript layers, revision data as appropriate, observations, interpretations, processor definitions and versions, memories/rules, evidence links, timestamps, timezone data, provenance, and deletion/retention metadata needed to interpret the archive.

**PORT-005** Exported relationships SHALL use stable identifiers or an equivalent mechanism so evidence and derivations remain traceable.

**PORT-006** The system SHOULD offer both human-readable and machine-readable exports.

**PORT-007** Export and restore SHALL preserve unknown/neutral/zero distinctions and manual-authority status.

**PORT-008** The user SHALL not be locked into a particular model provider, storage provider, or application host to retain access to their journal corpus.

## 20. Provider and model agnosticism

**MODEL-001** Speech recognition, cleanup, extraction, interpretation, embedding, and generation capabilities SHALL be described by capability and configuration rather than hard-wired to a named provider.

**MODEL-002** The system SHALL support recording provider, model, model version/name, configuration, and prompt/processor version for each AI operation.

**MODEL-003** Changing providers SHALL not alter the canonical source model or make prior results unreadable.

**MODEL-004** Unsupported provider features, such as missing word timestamps, SHALL degrade gracefully and be represented explicitly.

**MODEL-005** The architecture SHOULD permit side-by-side evaluation or replacement of models without changing user-authored data.

**MODEL-006** Provider-specific raw responses MAY be retained for audit or future use, subject to privacy and export policies.

## 21. Core workflows

### 21.1 Record and process

1. The user selects or accepts a Journal Day.
2. The system creates a stable recording identity and begins recoverable capture.
3. Recording stops; the audio remains locally recoverable until durable persistence is confirmed.
4. The system saves the immutable original audio and metadata.
5. STT runs with the effective, versioned global context.
6. The immutable raw STT and available timestamps are saved.
7. A corrected transcript is initialized; the user may correct it.
8. A cleaned transcript is derived from the corrected transcript.
9. enabled processors run according to their input dependencies.
10. Results appear with evidence, provenance, confidence/uncertainty, and state.
11. Missing required information is consolidated into an appropriate nudge.

### 21.2 Correct and remember

1. The user corrects a transcript or result.
2. The occurrence is immediately corrected and marked user-authored/user-corrected.
3. The system may offer to remember a suitable name, term, alias, or rule.
4. If approved, a visible scoped memory is created.
5. Dependent artifacts become stale and may be reprocessed.
6. Reprocessing preserves the manual correction.

### 21.3 Add a later clarification

1. The user adds another contribution to an existing day.
2. Contribution-level processing runs where applicable.
3. Day-level processors reconcile the full day state.
4. Existing observations may be updated or superseded instead of duplicated.
5. Interpretations and nudges are refreshed while respecting manual overrides and dismissals.

### 21.4 Reprocess history

1. The user selects a processor/version and historical scope.
2. The system previews affected dates, stale/manual data, and approximate operation scope.
3. A new processing run is recorded without erasing audit history.
4. Manual values remain authoritative; conflicts are surfaced for review.
5. Reports identify the resulting version basis.

### 21.5 Search and answer

1. The user issues a lexical or natural-language query.
2. The system retrieves matching sources and/or derived data.
3. If synthesis is requested, the system answers only from retrieved material.
4. Results cite and navigate to the supporting Journal Days and spans.

## 22. Edge cases and required behavior

| Edge case                                           | Required behavior                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Multiple recordings in one day                      | Preserve each separately; present a unified day if desired.                                             |
| Recording after midnight about the prior waking day | Allow assignment to the prior Journal Day; retain actual capture time and timezone.                     |
| Travel across timezones                             | Use the recorded timezone and configured Journal Timezone; never silently move existing items.          |
| No timestamps from STT                              | Preserve transcript and mark timing unavailable.                                                        |
| Raw STT is wrong but cleaned text looks plausible   | Preserve raw STT; allow correction before regenerating cleanup and derived results.                     |
| Correction changes “Monday” to “Tuesday”            | Correct only that occurrence unless the user explicitly creates a broader rule.                         |
| Name correction recurs                              | Suggest a visible known-entity/alias memory; do not silently globalize it.                              |
| User mentions another person's meal                 | Do not record it as the user's consumption.                                                             |
| User says they bought or considered food            | Do not infer consumption.                                                                               |
| Later food statement adds quantity/detail           | Update or supersede the original event; avoid a duplicate.                                              |
| User had a bad morning and good evening             | Preserve both mood observations; compute any aggregate separately.                                      |
| Mood is not discussed                               | Record insufficient information, never neutral.                                                         |
| “I slept badly last night” in Monday's journal      | Associate nightly sleep with Monday by wake-date convention, retaining evidence and correction ability. |
| Nap plus nightly sleep                              | Store separate sleep events.                                                                            |
| “Maybe I should…”                                   | Preserve as tentative/contemplative, not a firm task by default.                                        |
| “I called the dentist”                              | Treat as an accomplished event, not a future task.                                                      |
| Processor/API outage                                | Save journal and audio; show stage failure; retry later.                                                |
| Upload interrupted                                  | Retain recoverable local capture and retry with the same recording identity.                            |
| Transcript edited after extraction                  | Mark dependent outputs stale; do not silently treat them as current.                                    |
| Reprocessing conflicts with manual rating           | Preserve manual rating and show the new AI suggestion separately.                                       |
| Required processor fails technically                | Show failure, not a “you forgot” nudge.                                                                 |
| User dismisses a nudge                              | Preserve dismissal for that day; do not repeatedly prompt unless explicitly configured.                 |
| Audio deleted, transcript retained                  | Retain text and provenance; mark audio evidence/playback unavailable.                                   |
| Processor schema evolves                            | Preserve old payload/version; migrate or reprocess only explicitly.                                     |
| Search answer lacks support                         | State that evidence is insufficient and show the closest sources, if useful.                            |

## 23. Acceptance criteria

### 23.1 Capture and durability

**AC-001** Given two recordings and one typed note assigned to the same date, the system displays one Journal Day while preserving three individually identifiable contributions.

**AC-002** Given a completed recording whose network upload is interrupted, reopening or reconnecting offers recovery/retry and does not create a duplicate after success.

**AC-003** Given transcription or processor failure, the original recording and typed material remain accessible and editable.

### 23.2 Transcript lineage

**AC-010** A user can inspect original audio, immutable raw STT, corrected transcript, and cleaned transcript as distinct artifacts.

**AC-011** Editing the corrected transcript leaves raw STT unchanged and marks dependent cleanup/results stale.

**AC-012** When timestamps exist, selecting a supported evidence span can navigate to the relevant audio region; when absent, the interface clearly indicates that timing is unavailable.

### 23.3 Processor correctness

**AC-020** “I bought a burrito but Nicolette ate it” produces no user food-consumption event.

**AC-021** “I had pizza for lunch” followed by “it was two slices of pepperoni pizza” results in one reconciled consumption event, not two independent meals.

**AC-022** No mood mention produces “insufficient information” and is excluded from numerical averages unless explicitly imputed by a disclosed rule.

**AC-023** Mixed morning and evening mood produces multiple observations and a separately inspectable aggregate.

**AC-024** A tentative idea and a firm dated obligation remain distinguishable in task-like results.

### 23.4 Memory and authority

**AC-030** A transcript edit does not become a global rule unless the user chooses “remember” or approves a suggestion.

**AC-031** Every active persistent correction/memory is visible and can be edited, disabled, or deleted.

**AC-032** Reprocessing never silently overwrites a manually corrected mood, food quantity, task date, transcript, or summary bullet.

### 23.5 Time and nudges

**AC-040** A 12:30 a.m. recording can be assigned to the prior Journal Day while retaining its actual timestamp and timezone.

**AC-041** “Tomorrow” is stored with both its original phrase and resolved date based on the contribution context.

**AC-042** Three missing required processors can produce one consolidated nudge; dismissing it for the day prevents repeated default prompting.

**AC-043** A processor failure cannot be mistaken for insufficient user input.

### 23.6 Portability and auditability

**AC-050** A complete export contains enough information to associate audio, transcript layers, evidence, results, versions, and memories without access to the running application.

**AC-051** A result inspector can show which source(s), evidence, processor definition, prompt/instruction version, provider/model, and processing time produced a result.

**AC-052** Switching a configured AI provider does not change or invalidate previously captured sources or prevent access to earlier results.

## 24. Future extensions

The processor framework SHOULD support future domains such as exercise, symptoms, medication adherence, spending, social interactions, locations, projects, habits, gratitude, media, and long-term themes. Such extensions SHALL inherit the same requirements for provenance, uncertainty, visible rules, manual authority, versioning, reprocessing, privacy, and exportability.

Possible future capabilities include external task synchronization, user-approved calendar context, trend views, cross-day interpretations, periodic retrospectives, and comparative processor evaluation. None may weaken the canonical-source principle or silently convert inference into fact.

## 25. Product-level decisions recorded by this specification

- The day is a container, not a monolithic entry.
- Original audio and raw STT are immutable source artifacts.
- Correcting what was said is separate from editorial cleanup.
- Observations are separate from interpretations and aggregates.
- Every useful AI claim should be traceable to evidence.
- Missing data is distinct from zero, none, neutral, and not applicable.
- Nightly sleep belongs by default to the wake date; naps are separate events.
- Food is modeled as consumption events with reconciliation semantics.
- Tasks are distinguished from contemplation, recommendations, and completed actions.
- Required processors use explicit nudge states and notification limits.
- AI behavior, memories, and correction rules remain visible and controllable.
- Processor, prompt/instruction, model, and provider versions are retained.
- Reprocessing is intentional and manual work always wins.
- Capture remains usable through AI outages, interrupted uploads, and offline periods.
- Audio can be retained or independently deleted without destroying the journal text.
- Search answers remain grounded in and linked to sources.
- Privacy, exportability, and provider independence are foundational requirements.
