import { createHash } from 'node:crypto';

import {
  processorDefinitionDraftSchema,
  type ProcessorDefinitionDraft,
} from '@journal/contracts';
import { createUuidV7 } from '@journal/domain';
import {
  PROCESSOR_PROMPT_ASSEMBLY_VERSION,
  assembleProcessorInput,
  processorInputLabel,
  type ProcessorInputBundle,
  type ProcessorInputSource,
  type ProcessorTemporalContext,
  type ValidatedProcessorOutput,
} from '@journal/processors';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import type {
  JournalDatabase,
  JournalTransaction,
  RepositoryContext,
} from './client.js';
import { createQueueJobPayload, queueNames } from './queue-contracts.js';
import { enqueueJobInTransaction, QueueJobError } from './queue-runtime.js';
import {
  contributionRevisions,
  contributions,
  journalDays,
  processorInstallations,
  processorArtifacts,
  processorArtifactVersions,
  processorResultEvidence,
  processorResults,
  processorRunInputs,
  processorRuns,
  processorVersionDependencies,
  processorVersions,
  recordings,
  transcriptRevisions,
  transcriptSegments,
  transcripts,
} from './schema.js';
import { inTransaction } from './transaction.js';
import { reconcileProcessorResult } from './processor-reconciliation-repository.js';

export const PROCESSOR_JOB_OPERATION = 'execute_processor';

export type ProcessorRunRecord = typeof processorRuns.$inferSelect;
export type ProcessorResultRecord = typeof processorResults.$inferSelect;

export interface ProcessorRunTarget {
  readonly scope: 'contribution' | 'journal_day';
  readonly journalDayId: string;
  readonly contributionId?: string;
}

export interface CanonicalProcessorRunInput {
  readonly run: ProcessorRunRecord;
  readonly processor: typeof processorInstallations.$inferSelect;
  readonly version: typeof processorVersions.$inferSelect;
  readonly definition: ProcessorDefinitionDraft;
  readonly sources: readonly ProcessorInputSource[];
  readonly bundle: ProcessorInputBundle;
}

export class ProcessorRuntimeStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ProcessorRuntimeStateError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function jsonPointer(value: unknown, pointer: string): unknown {
  let current = value;
  for (const token of pointer
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current) ||
      !(token in current)
    ) {
      throw new ProcessorRuntimeStateError(
        'A recorded processor dependency selector is unavailable.',
      );
    }
    current = (current as Readonly<Record<string, unknown>>)[token];
  }
  return current;
}

function runFingerprint(input: {
  readonly bundleFingerprint: string;
  readonly processorVersionId: string;
  readonly promptTemplateHash: string;
  readonly requestedConfiguration: Readonly<Record<string, unknown>>;
}): string {
  return sha256(canonicalJson(input));
}

function temporal(row: {
  capturedAt: Date;
  capturedTimezone: string;
  journalDate: string;
  journalTimezone: string;
  journalDateAssignment: 'default' | 'migration' | 'user_override';
}): ProcessorTemporalContext {
  return Object.freeze({
    capturedAt: row.capturedAt.toISOString(),
    capturedTimezone: row.capturedTimezone,
    journalDate: row.journalDate,
    journalTimezone: row.journalTimezone,
    journalDateAssignment: row.journalDateAssignment,
  });
}

async function loadSourceInputs(
  context: RepositoryContext,
  definition: ProcessorDefinitionDraft,
  target: ProcessorRunTarget,
): Promise<readonly ProcessorInputSource[]> {
  if (definition.input.scope !== target.scope) {
    throw new ProcessorRuntimeStateError(
      'Processor target scope does not match its immutable definition.',
    );
  }
  if (target.scope === 'contribution' && target.contributionId === undefined) {
    throw new ProcessorRuntimeStateError(
      'Contribution-scoped processor target requires a contribution ID.',
    );
  }
  const contributionId = target.contributionId;
  const contributionFilter =
    target.scope === 'contribution'
      ? and(
          eq(contributions.journalDayId, target.journalDayId),
          eq(contributions.id, contributionId as string),
        )
      : eq(contributions.journalDayId, target.journalDayId);
  const sources: ProcessorInputSource[] = [];
  if (definition.input.selectors.includes('typed_text')) {
    const rows = await context
      .select({
        revisionId: contributionRevisions.id,
        text: contributionRevisions.text,
        capturedAt: contributions.capturedAt,
        capturedTimezone: contributions.capturedTimezone,
        journalTimezone: contributions.journalTimezone,
        journalDateAssignment: contributions.journalDateAssignment,
        journalDate: journalDays.journalDate,
      })
      .from(contributions)
      .innerJoin(journalDays, eq(journalDays.id, contributions.journalDayId))
      .innerJoin(
        contributionRevisions,
        eq(contributionRevisions.id, contributions.currentRevisionId),
      )
      .where(
        and(
          contributionFilter,
          eq(contributions.sourceType, 'typed_text'),
          isNull(contributions.deletedAt),
        ),
      )
      .orderBy(asc(contributions.capturedAt), asc(contributions.id));
    for (const row of rows) {
      const identity = {
        sourceType: 'typed_text' as const,
        sourceRevisionId: row.revisionId,
      };
      sources.push(
        Object.freeze({
          ...identity,
          label: processorInputLabel(identity),
          content: row.text,
          temporal: temporal(row),
        }),
      );
    }
  }
  const transcriptSelectors = definition.input.selectors.filter(
    (selector): selector is 'corrected_transcript' | 'cleaned_transcript' =>
      selector === 'corrected_transcript' || selector === 'cleaned_transcript',
  );
  for (const layer of transcriptSelectors) {
    const rows = await context
      .select({
        revisionId: transcriptRevisions.id,
        evidenceText: transcriptRevisions.evidenceText,
        capturedAt: contributions.capturedAt,
        capturedTimezone: contributions.capturedTimezone,
        journalTimezone: contributions.journalTimezone,
        journalDateAssignment: contributions.journalDateAssignment,
        journalDate: journalDays.journalDate,
      })
      .from(transcripts)
      .innerJoin(
        transcriptRevisions,
        eq(transcriptRevisions.id, transcripts.currentRevisionId),
      )
      .innerJoin(recordings, eq(recordings.id, transcripts.recordingId))
      .innerJoin(contributions, eq(contributions.id, recordings.contributionId))
      .innerJoin(journalDays, eq(journalDays.id, contributions.journalDayId))
      .where(
        and(
          contributionFilter,
          eq(
            transcripts.layer,
            layer === 'corrected_transcript' ? 'corrected' : 'cleaned',
          ),
          isNull(contributions.deletedAt),
          isNull(transcriptRevisions.staleAt),
        ),
      )
      .orderBy(asc(contributions.capturedAt), asc(contributions.id));
    const ranges =
      rows.length === 0
        ? []
        : await context
            .select({
              transcriptRevisionId: transcriptSegments.transcriptRevisionId,
              startUtf16: transcriptSegments.startUtf16,
              endUtf16: transcriptSegments.endUtf16,
              startMs: transcriptSegments.startMs,
              endMs: transcriptSegments.endMs,
            })
            .from(transcriptSegments)
            .where(
              inArray(
                transcriptSegments.transcriptRevisionId,
                rows.map(({ revisionId }) => revisionId),
              ),
            )
            .orderBy(asc(transcriptSegments.ordinal));
    for (const row of rows) {
      const identity = { sourceType: layer, sourceRevisionId: row.revisionId };
      const audioRanges = ranges.flatMap((range) => {
        if (
          range.transcriptRevisionId !== row.revisionId ||
          range.startMs === null ||
          range.endMs === null
        )
          return [];
        return [
          {
            startUtf16: range.startUtf16,
            endUtf16: range.endUtf16,
            startMs: Number(range.startMs),
            endMs: Number(range.endMs),
          },
        ];
      });
      sources.push(
        Object.freeze({
          ...identity,
          label: processorInputLabel(identity),
          content: row.evidenceText,
          temporal: temporal(row),
          ...(audioRanges.length === 0
            ? {}
            : { audioRanges: Object.freeze(audioRanges) }),
        }),
      );
    }
  }
  const requestsArtifactInputs =
    definition.input.selectors.includes('observations') ||
    definition.input.selectors.includes('processor_results');
  if (requestsArtifactInputs && definition.dependencies.length === 0) {
    throw new ProcessorRuntimeStateError(
      'Artifact-set inputs require at least one exact processor-version dependency.',
    );
  }
  for (const dependency of definition.dependencies) {
    const [result] = await context
      .select()
      .from(processorResults)
      .where(
        and(
          eq(processorResults.processorVersionId, dependency.upstreamVersionId),
          eq(processorResults.targetJournalDayId, target.journalDayId),
          target.contributionId === undefined
            ? undefined
            : sql`(${processorResults.targetContributionId} is null or ${processorResults.targetContributionId} = ${target.contributionId})`,
          eq(processorResults.lifecycle, 'active'),
          isNull(processorResults.staleAt),
          dependency.acceptPartial
            ? undefined
            : eq(processorResults.completeness, 'complete'),
        ),
      )
      .orderBy(desc(processorResults.createdAt), desc(processorResults.id))
      .limit(1);
    if (result === undefined) {
      throw new ProcessorRuntimeStateError(
        'An exact processor dependency has no current successful result.',
      );
    }
    const [upstreamInput] = await context
      .select({ temporalContext: processorRunInputs.temporalContext })
      .from(processorRunInputs)
      .where(eq(processorRunInputs.runId, result.runId))
      .orderBy(asc(processorRunInputs.ordinal))
      .limit(1);
    if (upstreamInput === undefined) {
      throw new ProcessorRuntimeStateError(
        'An artifact input has no reconstructable temporal context.',
      );
    }
    const identity = {
      sourceType: 'processor_result' as const,
      processorResultId: result.id,
      outputSelector: dependency.outputSelector,
    };
    sources.push(
      Object.freeze({
        ...identity,
        label: processorInputLabel(identity),
        content: canonicalJson(
          jsonPointer(result.payload, dependency.outputSelector),
        ),
        temporal:
          upstreamInput.temporalContext as unknown as ProcessorTemporalContext,
      }),
    );
  }
  return Object.freeze(sources);
}

export async function enqueueProcessorRun(input: {
  readonly boss: PgBoss;
  readonly transaction: JournalTransaction;
  readonly processorVersionId: string;
  readonly target: ProcessorRunTarget;
  readonly requestedConfiguration?: Readonly<Record<string, unknown>>;
  readonly retryTerminal?: boolean;
  readonly forceReprocess?: boolean;
  readonly now?: Date;
  readonly createId?: () => string;
}): Promise<ProcessorRunRecord> {
  const now = input.now ?? new Date();
  const createId =
    input.createId ?? (() => createUuidV7<'processor-runtime'>());
  const [published] = await input.transaction
    .select({ processor: processorInstallations, version: processorVersions })
    .from(processorVersions)
    .innerJoin(
      processorInstallations,
      eq(processorInstallations.id, processorVersions.processorId),
    )
    .where(eq(processorVersions.id, input.processorVersionId))
    .limit(1);
  if (published === undefined)
    throw new ProcessorRuntimeStateError('Processor version does not exist.');
  const definition = processorDefinitionDraftSchema.parse(
    published.version.definition,
  );
  const sources = await loadSourceInputs(
    input.transaction,
    definition,
    input.target,
  );
  const bundle = assembleProcessorInput({ definition, sources });
  const requestedConfiguration = input.requestedConfiguration ?? {};
  const inputFingerprint = runFingerprint({
    bundleFingerprint: bundle.fingerprint,
    processorVersionId: published.version.id,
    promptTemplateHash: published.version.promptTemplateHash,
    requestedConfiguration,
  });
  // Attempt numbers are unique per immutable version/target. Serialize the
  // read-and-increment boundary so concurrent retries or reprocessing batches
  // create linked attempts instead of racing on the uniqueness constraint.
  await input.transaction.execute(sql`
    select pg_advisory_xact_lock(
      hashtext(
        ${`${published.version.id}:${input.target.scope}:${input.target.journalDayId}:${input.target.contributionId ?? ''}`}
      )
    )
  `);
  const [latest] = await input.transaction
    .select()
    .from(processorRuns)
    .where(
      and(
        eq(processorRuns.processorVersionId, published.version.id),
        eq(processorRuns.targetScope, input.target.scope),
        eq(processorRuns.targetJournalDayId, input.target.journalDayId),
        input.target.contributionId === undefined
          ? isNull(processorRuns.targetContributionId)
          : eq(processorRuns.targetContributionId, input.target.contributionId),
      ),
    )
    .orderBy(desc(processorRuns.attempt))
    .limit(1);
  if (
    latest !== undefined &&
    latest.inputFingerprint === inputFingerprint &&
    !input.retryTerminal &&
    !input.forceReprocess
  )
    return latest;
  if (
    latest !== undefined &&
    !input.forceReprocess &&
    input.retryTerminal &&
    latest.inputFingerprint !== inputFingerprint
  )
    throw new ProcessorRuntimeStateError(
      'A processor retry must preserve exact inputs, prompt, and requested configuration.',
    );
  if (
    latest !== undefined &&
    !input.forceReprocess &&
    latest.inputFingerprint === inputFingerprint &&
    latest.status !== 'failed' &&
    latest.status !== 'canceled'
  )
    throw new ProcessorRuntimeStateError(
      'Only failed or canceled processor work can be retried.',
    );
  const runId = createId();
  const [run] = await input.transaction
    .insert(processorRuns)
    .values({
      id: runId,
      processorId: published.processor.id,
      processorVersionId: published.version.id,
      targetScope: input.target.scope,
      targetJournalDayId: input.target.journalDayId,
      ...(input.target.contributionId === undefined
        ? {}
        : { targetContributionId: input.target.contributionId }),
      ...(latest === undefined ? {} : { predecessorRunId: latest.id }),
      attempt: (latest?.attempt ?? 0) + 1,
      inputCompleteness: bundle.completeness,
      inputFingerprint,
      promptAssemblyVersion: PROCESSOR_PROMPT_ASSEMBLY_VERSION,
      promptTemplateHash: published.version.promptTemplateHash,
      requestedConfiguration,
      queuedAt: now,
      updatedAt: now,
    })
    .returning();
  if (run === undefined)
    throw new ProcessorRuntimeStateError('Processor run was not created.');
  if (sources.length > 0) {
    const persistedInputs: (typeof processorRunInputs.$inferInsert)[] =
      sources.map((source, ordinal) => {
        const entry = bundle.entries.find(
          ({ label }) => label === source.label,
        );
        const normalizedContent =
          source.sourceType === 'processor_result'
            ? source.content
            : source.content
                .replaceAll('\r\n', '\n')
                .replaceAll('\r', '\n')
                .normalize('NFC');
        return {
          runId: run.id,
          ordinal,
          label: source.label,
          inputKind: source.sourceType,
          ...(source.sourceType === 'typed_text'
            ? { contributionRevisionId: source.sourceRevisionId }
            : source.sourceType === 'processor_result'
              ? { processorResultId: source.processorResultId }
              : { transcriptRevisionId: source.sourceRevisionId }),
          ...(source.outputSelector === undefined
            ? {}
            : { outputSelector: source.outputSelector }),
          includedStartUtf16: 0,
          includedEndUtf16: entry?.includedEndUtf16 ?? 0,
          fullLengthUtf16: normalizedContent.length,
          contentHash: sha256(normalizedContent),
          temporalContext: { ...source.temporal },
          createdAt: now,
        };
      });
    await input.transaction.insert(processorRunInputs).values(persistedInputs);
  }
  await enqueueJobInTransaction({
    boss: input.boss,
    jobId: run.id,
    queueName: queueNames.processing,
    transaction: input.transaction,
    payload: createQueueJobPayload({
      identifiers: {
        inputKey: run.inputFingerprint,
        processorVersionId: run.processorVersionId,
        runId: run.id,
      },
      operation: PROCESSOR_JOB_OPERATION,
      queueName: queueNames.processing,
    }),
  });
  return run;
}

export type ProcessorChangedInput =
  | Readonly<{ kind: 'contribution_revision'; id: string }>
  | Readonly<{ kind: 'transcript_revision'; id: string }>
  | Readonly<{ kind: 'processor_result'; id: string }>;

export interface ProcessorInvalidationResult {
  readonly staleResultIds: readonly string[];
  readonly canceledRunIds: readonly string[];
  readonly replacementRunIds: readonly string[];
}

function changedInputPredicate(input: ProcessorChangedInput) {
  switch (input.kind) {
    case 'contribution_revision':
      return eq(processorRunInputs.contributionRevisionId, input.id);
    case 'transcript_revision':
      return eq(processorRunInputs.transcriptRevisionId, input.id);
    case 'processor_result':
      return eq(processorRunInputs.processorResultId, input.id);
  }
}

/**
 * Traverses immutable run-input edges and stales only actual downstream
 * results. Replacement jobs bind fresh canonical inputs and contain IDs only.
 */
export async function invalidateProcessorDependents(input: {
  readonly boss?: PgBoss;
  readonly transaction: JournalTransaction;
  readonly changedInput: ProcessorChangedInput;
  readonly now: Date;
  readonly enqueueReplacements?: boolean;
}): Promise<ProcessorInvalidationResult> {
  const direct = await input.transaction
    .select({ runId: processorRunInputs.runId })
    .from(processorRunInputs)
    .where(changedInputPredicate(input.changedInput));
  const directRunIds = [...new Set(direct.map(({ runId }) => runId))];
  if (directRunIds.length === 0)
    return Object.freeze({
      staleResultIds: Object.freeze([]),
      canceledRunIds: Object.freeze([]),
      replacementRunIds: Object.freeze([]),
    });

  const traversed = await input.transaction.execute<{
    run_id: string;
    result_id: string | null;
  }>(sql`
    with recursive impacted_run(run_id) as (
      select source.id
      from (values ${sql.join(
        directRunIds.map((id) => sql`(${id}::uuid)`),
        sql`, `,
      )}) as source(id)
      union
      select child_input.run_id
      from ${processorRunInputs} child_input
      inner join ${processorResults} parent_result
        on parent_result.id = child_input.processor_result_id
      inner join impacted_run parent_run
        on parent_run.run_id = parent_result.run_id
    )
    select impacted_run.run_id, result.id as result_id
    from impacted_run
    left join ${processorResults} result on result.run_id = impacted_run.run_id
    order by impacted_run.run_id
  `);
  const impactedRunIds = [
    ...new Set(traversed.rows.map(({ run_id }) => run_id)),
  ];
  const resultIds = [
    ...new Set(
      traversed.rows.flatMap(({ result_id }) =>
        result_id === null ? [] : [result_id],
      ),
    ),
  ];
  const staleResults =
    resultIds.length === 0
      ? []
      : await input.transaction
          .update(processorResults)
          .set({
            staleAt: input.now,
            staleReason: 'input_revision_superseded',
            updatedAt: input.now,
          })
          .where(
            and(
              inArray(processorResults.id, resultIds),
              isNull(processorResults.staleAt),
            ),
          )
          .returning({ id: processorResults.id });
  if (resultIds.length > 0) {
    await input.transaction
      .update(processorResultEvidence)
      .set({
        resolutionStatus: 'stale',
        unresolvedReason: 'input_revision_superseded',
        updatedAt: input.now,
      })
      .where(inArray(processorResultEvidence.processorResultId, resultIds));
    const activeArtifactVersions = await input.transaction
      .select({
        artifactId: processorArtifactVersions.artifactId,
        versionId: processorArtifactVersions.id,
      })
      .from(processorArtifactVersions)
      .innerJoin(
        processorArtifacts,
        eq(processorArtifacts.id, processorArtifactVersions.artifactId),
      )
      .where(
        and(
          inArray(processorArtifactVersions.sourceResultId, resultIds),
          eq(processorArtifactVersions.lifecycle, 'active'),
          eq(processorArtifacts.authority, 'generated'),
        ),
      );
    if (activeArtifactVersions.length > 0) {
      await input.transaction
        .update(processorArtifactVersions)
        .set({ lifecycle: 'superseded', supersededAt: input.now })
        .where(
          inArray(
            processorArtifactVersions.id,
            activeArtifactVersions.map(({ versionId }) => versionId),
          ),
        );
      await input.transaction
        .update(processorArtifacts)
        .set({ active: false, updatedAt: input.now })
        .where(
          inArray(
            processorArtifacts.id,
            activeArtifactVersions.map(({ artifactId }) => artifactId),
          ),
        );
    }
  }
  const canceled = await input.transaction
    .update(processorRuns)
    .set({
      status: 'canceled',
      completedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        inArray(processorRuns.id, impactedRunIds),
        inArray(processorRuns.status, ['queued', 'running']),
      ),
    )
    .returning({ id: processorRuns.id });

  const replacementRunIds: string[] = [];
  if (input.enqueueReplacements !== false) {
    const candidates = await input.transaction
      .select({
        run: processorRuns,
        currentVersionId: processorInstallations.currentVersionId,
        enabled: processorInstallations.enabled,
      })
      .from(processorRuns)
      .innerJoin(
        processorInstallations,
        eq(processorInstallations.id, processorRuns.processorId),
      )
      .where(inArray(processorRuns.id, directRunIds));
    const scheduled = new Set<string>();
    for (const candidate of candidates) {
      if (!candidate.enabled || candidate.currentVersionId === null) continue;
      if (input.boss === undefined)
        throw new ProcessorRuntimeStateError(
          'Processor queue is required to enqueue invalidation replacements.',
        );
      const target: ProcessorRunTarget =
        candidate.run.targetScope === 'contribution' &&
        candidate.run.targetContributionId !== null
          ? {
              scope: 'contribution',
              journalDayId: candidate.run.targetJournalDayId as string,
              contributionId: candidate.run.targetContributionId,
            }
          : {
              scope: 'journal_day',
              journalDayId: candidate.run.targetJournalDayId as string,
            };
      const key = `${candidate.currentVersionId}:${target.scope}:${target.journalDayId}:${target.contributionId ?? ''}`;
      if (scheduled.has(key)) continue;
      scheduled.add(key);
      const replacement = await enqueueProcessorRun({
        boss: input.boss,
        transaction: input.transaction,
        processorVersionId: candidate.currentVersionId,
        target,
        requestedConfiguration: candidate.run.requestedConfiguration,
        now: input.now,
      });
      if (replacement.id !== candidate.run.id)
        replacementRunIds.push(replacement.id);
    }
  }
  return Object.freeze({
    staleResultIds: Object.freeze(staleResults.map(({ id }) => id)),
    canceledRunIds: Object.freeze(canceled.map(({ id }) => id)),
    replacementRunIds: Object.freeze(replacementRunIds),
  });
}

export class ProcessorRuntimeRepository {
  public constructor(
    private readonly database: JournalDatabase,
    private readonly boss?: PgBoss,
  ) {}

  public async load(runId: string): Promise<CanonicalProcessorRunInput> {
    const [row] = await this.database
      .select({
        run: processorRuns,
        processor: processorInstallations,
        version: processorVersions,
      })
      .from(processorRuns)
      .innerJoin(
        processorInstallations,
        eq(processorInstallations.id, processorRuns.processorId),
      )
      .innerJoin(
        processorVersions,
        eq(processorVersions.id, processorRuns.processorVersionId),
      )
      .where(eq(processorRuns.id, runId))
      .limit(1);
    if (row === undefined)
      throw new QueueJobError('permanent', 'Processor run does not exist.');
    const definition = processorDefinitionDraftSchema.parse(
      row.version.definition,
    );
    if (row.run.targetJournalDayId === null)
      throw new QueueJobError(
        'permanent',
        'Processor run target day is missing.',
      );
    const bindings = await this.database
      .select()
      .from(processorRunInputs)
      .where(eq(processorRunInputs.runId, row.run.id))
      .orderBy(asc(processorRunInputs.ordinal));
    const sources: ProcessorInputSource[] = [];
    for (const binding of bindings) {
      const temporalContext =
        binding.temporalContext as unknown as ProcessorTemporalContext;
      if (binding.inputKind === 'processor_result') {
        if (
          binding.processorResultId === null ||
          binding.outputSelector === null
        )
          throw new QueueJobError(
            'permanent',
            'Processor-result input binding is invalid.',
          );
        const [source] = await this.database
          .select({
            payload: processorResults.payload,
            staleAt: processorResults.staleAt,
            lifecycle: processorResults.lifecycle,
          })
          .from(processorResults)
          .where(eq(processorResults.id, binding.processorResultId))
          .limit(1);
        if (
          source === undefined ||
          source.staleAt !== null ||
          source.lifecycle !== 'active'
        )
          throw new QueueJobError(
            'canceled',
            'Bound processor result is no longer current.',
          );
        const content = canonicalJson(
          jsonPointer(source.payload, binding.outputSelector),
        );
        if (sha256(content) !== binding.contentHash)
          throw new QueueJobError(
            'permanent',
            'Bound processor-result content no longer matches its immutable hash.',
          );
        sources.push({
          sourceType: 'processor_result',
          processorResultId: binding.processorResultId,
          outputSelector: binding.outputSelector,
          label: binding.label,
          content,
          temporal: temporalContext,
        });
        continue;
      }
      if (binding.inputKind === 'typed_text') {
        if (binding.contributionRevisionId === null)
          throw new QueueJobError(
            'permanent',
            'Typed input binding is invalid.',
          );
        const [source] = await this.database
          .select({
            text: contributionRevisions.text,
            deletedAt: contributions.deletedAt,
          })
          .from(contributionRevisions)
          .innerJoin(
            contributions,
            eq(contributions.id, contributionRevisions.contributionId),
          )
          .where(eq(contributionRevisions.id, binding.contributionRevisionId))
          .limit(1);
        if (source === undefined || source.deletedAt !== null)
          throw new QueueJobError(
            'canceled',
            'Bound typed source is unavailable.',
          );
        const identity = {
          sourceType: 'typed_text' as const,
          sourceRevisionId: binding.contributionRevisionId,
        };
        sources.push({
          ...identity,
          label: binding.label,
          content: source.text,
          temporal: temporalContext,
        });
        continue;
      }
      if (binding.transcriptRevisionId === null)
        throw new QueueJobError(
          'permanent',
          'Transcript input binding is invalid.',
        );
      const [source] = await this.database
        .select({
          evidenceText: transcriptRevisions.evidenceText,
          deletedAt: contributions.deletedAt,
        })
        .from(transcriptRevisions)
        .innerJoin(
          transcripts,
          eq(transcripts.id, transcriptRevisions.transcriptId),
        )
        .innerJoin(recordings, eq(recordings.id, transcripts.recordingId))
        .innerJoin(
          contributions,
          eq(contributions.id, recordings.contributionId),
        )
        .where(eq(transcriptRevisions.id, binding.transcriptRevisionId))
        .limit(1);
      if (source === undefined || source.deletedAt !== null)
        throw new QueueJobError(
          'canceled',
          'Bound transcript source is unavailable.',
        );
      const ranges = await this.database
        .select({
          startUtf16: transcriptSegments.startUtf16,
          endUtf16: transcriptSegments.endUtf16,
          startMs: transcriptSegments.startMs,
          endMs: transcriptSegments.endMs,
        })
        .from(transcriptSegments)
        .where(
          eq(
            transcriptSegments.transcriptRevisionId,
            binding.transcriptRevisionId,
          ),
        )
        .orderBy(asc(transcriptSegments.ordinal));
      const audioRanges = ranges.flatMap((range) =>
        range.startMs === null || range.endMs === null
          ? []
          : [
              {
                startUtf16: range.startUtf16,
                endUtf16: range.endUtf16,
                startMs: Number(range.startMs),
                endMs: Number(range.endMs),
              },
            ],
      );
      const identity = {
        sourceType: binding.inputKind,
        sourceRevisionId: binding.transcriptRevisionId,
      };
      sources.push({
        ...identity,
        label: binding.label,
        content: source.evidenceText,
        temporal: temporalContext,
        ...(audioRanges.length === 0 ? {} : { audioRanges }),
      });
    }
    const bundle = assembleProcessorInput({ definition, sources });
    const inputFingerprint = runFingerprint({
      bundleFingerprint: bundle.fingerprint,
      processorVersionId: row.run.processorVersionId,
      promptTemplateHash: row.run.promptTemplateHash,
      requestedConfiguration: row.run.requestedConfiguration,
    });
    if (
      inputFingerprint !== row.run.inputFingerprint ||
      bundle.completeness !== row.run.inputCompleteness
    )
      throw new QueueJobError(
        'canceled',
        'Canonical processor inputs no longer match the queued immutable binding.',
      );
    return { ...row, definition, sources, bundle };
  }

  public async markRunning(runId: string, now = new Date()): Promise<boolean> {
    const [started] = await this.database
      .update(processorRuns)
      .set({
        status: 'running',
        startedAt: now,
        completedAt: null,
        errorCode: null,
        errorRetryable: null,
        executionCount: sql`${processorRuns.executionCount} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(processorRuns.id, runId),
          inArray(processorRuns.status, ['queued', 'failed']),
        ),
      )
      .returning({ id: processorRuns.id });
    return started !== undefined;
  }

  public async markCanceled(runId: string, now = new Date()): Promise<void> {
    await this.database
      .update(processorRuns)
      .set({ status: 'canceled', completedAt: now, updatedAt: now })
      .where(
        and(
          eq(processorRuns.id, runId),
          inArray(processorRuns.status, ['queued', 'running']),
        ),
      );
  }

  public async markFailed(
    runId: string,
    errorCode: string,
    retryable: boolean,
    now = new Date(),
  ): Promise<void> {
    await this.database
      .update(processorRuns)
      .set({
        status: 'failed',
        errorCode,
        errorRetryable: retryable,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(eq(processorRuns.id, runId), eq(processorRuns.status, 'running')),
      );
  }

  public async complete(input: {
    readonly runId: string;
    readonly resultId: string;
    readonly output: ValidatedProcessorOutput;
    readonly effectiveMessagesHash: string;
    readonly provider?: Readonly<Record<string, unknown>>;
    readonly model?: Readonly<Record<string, unknown>>;
    readonly effectiveConfiguration?: Readonly<Record<string, unknown>>;
    readonly usage?: Readonly<Record<string, unknown>>;
    readonly processingTimeMilliseconds: bigint;
    readonly rawResponse?: Readonly<{
      id: string;
      blobKey: string;
      mediaType: string;
      byteSize: bigint;
      sha256: string;
      providerRequestId?: string;
      retention: string;
      expiresAt: Date;
    }>;
    readonly now?: Date;
    readonly createId?: () => string;
  }): Promise<ProcessorResultRecord> {
    const now = input.now ?? new Date();
    const createId =
      input.createId ?? (() => createUuidV7<'processor-evidence'>());
    return inTransaction(this.database, async (transaction) => {
      const [run] = await transaction
        .select()
        .from(processorRuns)
        .where(eq(processorRuns.id, input.runId))
        .limit(1)
        .for('update');
      if (run === undefined)
        throw new ProcessorRuntimeStateError('Processor run does not exist.');
      if (run.status === 'succeeded') {
        if (run.outputResultId === null)
          throw new ProcessorRuntimeStateError(
            'Completed processor result identity is missing.',
          );
        const [existing] = await transaction
          .select()
          .from(processorResults)
          .where(eq(processorResults.id, run.outputResultId))
          .limit(1);
        if (existing === undefined)
          throw new ProcessorRuntimeStateError(
            'Completed processor result is missing.',
          );
        return existing;
      }
      if (run.status !== 'running')
        throw new ProcessorRuntimeStateError(
          'Only a running processor can complete.',
        );
      const [version] = await transaction
        .select()
        .from(processorVersions)
        .where(eq(processorVersions.id, run.processorVersionId))
        .limit(1);
      if (version === undefined)
        throw new ProcessorRuntimeStateError('Processor version is missing.');
      const definition = processorDefinitionDraftSchema.parse(
        version.definition,
      );
      if (run.targetJournalDayId === null)
        throw new ProcessorRuntimeStateError(
          'Processor target Journal Day is missing.',
        );
      const [result] = await transaction
        .insert(processorResults)
        .values({
          id: input.resultId,
          runId: run.id,
          processorId: run.processorId,
          processorVersionId: run.processorVersionId,
          targetJournalDayId: run.targetJournalDayId,
          ...(run.targetContributionId === null
            ? {}
            : { targetContributionId: run.targetContributionId }),
          kind:
            definition.kind === 'observation_extractor'
              ? 'observation'
              : definition.kind,
          completeness: input.output.completeness,
          payload: input.output.payload,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (result === undefined)
        throw new ProcessorRuntimeStateError(
          'Processor result was not stored.',
        );
      if (input.output.evidence.length > 0) {
        const persistedEvidence: (typeof processorResultEvidence.$inferInsert)[] =
          input.output.evidence.map((evidence) => ({
            id: createId(),
            processorResultId: result.id,
            sourceLabel: evidence.sourceLabel,
            ...(evidence.sourceType === 'typed_text'
              ? { contributionRevisionId: evidence.sourceRevisionId }
              : { transcriptRevisionId: evidence.sourceRevisionId }),
            normalization: evidence.normalization,
            offsetUnit: evidence.offsetUnit,
            startUtf16: evidence.startUtf16,
            endUtf16: evidence.endUtf16,
            ...(evidence.audioRange === undefined
              ? {}
              : {
                  startMs: BigInt(evidence.audioRange.startMs),
                  endMs: BigInt(evidence.audioRange.endMs),
                }),
            quote: evidence.quote,
            quoteHash: evidence.quoteHash,
            resolutionStatus: 'resolved',
            createdAt: now,
          }));
        await transaction
          .insert(processorResultEvidence)
          .values(persistedEvidence);
      }
      await reconcileProcessorResult({
        transaction,
        run,
        result,
        definition,
        now,
        createId,
      });
      await transaction
        .update(processorRuns)
        .set({
          status: 'succeeded',
          outputResultId: result.id,
          effectiveMessagesHash: input.effectiveMessagesHash,
          ...(input.provider === undefined ? {} : { provider: input.provider }),
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.effectiveConfiguration === undefined
            ? {}
            : { effectiveConfiguration: input.effectiveConfiguration }),
          ...(input.usage === undefined ? {} : { usage: input.usage }),
          processingTimeMilliseconds: input.processingTimeMilliseconds,
          ...(input.rawResponse === undefined
            ? {}
            : {
                rawResponseId: input.rawResponse.id,
                rawResponseBlobKey: input.rawResponse.blobKey,
                rawResponseMediaType: input.rawResponse.mediaType,
                rawResponseByteSize: input.rawResponse.byteSize,
                rawResponseSha256: input.rawResponse.sha256,
                ...(input.rawResponse.providerRequestId === undefined
                  ? {}
                  : {
                      rawResponseProviderRequestId:
                        input.rawResponse.providerRequestId,
                    }),
                rawResponseRetention: input.rawResponse.retention,
                rawResponseExpiresAt: input.rawResponse.expiresAt,
              }),
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(processorRuns.id, run.id));
      if (this.boss !== undefined) {
        const downstream = await transaction
          .select({
            installation: processorInstallations,
            version: processorVersions,
          })
          .from(processorVersionDependencies)
          .innerJoin(
            processorVersions,
            eq(
              processorVersions.id,
              processorVersionDependencies.processorVersionId,
            ),
          )
          .innerJoin(
            processorInstallations,
            and(
              eq(processorInstallations.id, processorVersions.processorId),
              eq(processorInstallations.currentVersionId, processorVersions.id),
            ),
          )
          .where(
            and(
              eq(
                processorVersionDependencies.upstreamVersionId,
                run.processorVersionId,
              ),
              eq(processorInstallations.enabled, true),
            ),
          );
        for (const candidate of downstream) {
          const downstreamDefinition = processorDefinitionDraftSchema.parse(
            candidate.version.definition,
          );
          if (
            downstreamDefinition.input.scope !== 'journal_day' &&
            downstreamDefinition.input.scope !== 'contribution'
          )
            continue;
          if (
            downstreamDefinition.input.scope === 'contribution' &&
            run.targetContributionId === null
          )
            continue;
          await enqueueProcessorRun({
            boss: this.boss,
            transaction,
            processorVersionId: candidate.version.id,
            target:
              downstreamDefinition.input.scope === 'contribution'
                ? {
                    scope: 'contribution',
                    journalDayId: run.targetJournalDayId,
                    contributionId: run.targetContributionId as string,
                  }
                : {
                    scope: 'journal_day',
                    journalDayId: run.targetJournalDayId,
                  },
            now,
          });
        }
      }
      return result;
    });
  }
}
