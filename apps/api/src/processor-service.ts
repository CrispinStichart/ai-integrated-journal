import { createHash } from 'node:crypto';

import {
  processorDefinitionDraftSchema,
  processorDryRunResponseSchema,
  processorResourceSchema,
  processorRunProvenanceSchema,
  type ProcessorDefinitionDraft,
  type ProcessorDryRunResponse,
  type ProcessorResource,
  type ProcessorRunProvenance,
  type ProcessorVersionResource,
} from '@journal/contracts';
import {
  auditEvents,
  inTransaction,
  journalDays,
  processorApiIdempotency,
  processorInstallations,
  processorReconciliationOutcomes,
  processorReconciliations,
  processorResults,
  processorRunInputs,
  processorRuns,
  processorVersionDependencies,
  processorVersions,
  type JournalDatabase,
  type RepositoryContext,
} from '@journal/database';
import { createUuidV7 } from '@journal/domain';
import {
  validateProcessorDefinition,
  type PublishedProcessorVersion,
} from '@journal/processors';
import { and, asc, eq, max, or } from 'drizzle-orm';

export class ProcessorNotFoundError extends Error {
  public constructor() {
    super('Processor not found.');
    this.name = 'ProcessorNotFoundError';
  }
}

export class ProcessorConflictError extends Error {
  public constructor(message = 'The processor configuration has changed.') {
    super(message);
    this.name = 'ProcessorConflictError';
  }
}

export class ProcessorDefinitionInvalidError extends Error {
  public constructor(
    public readonly issues: readonly ProcessorDryRunResponse['issues'][number][],
  ) {
    super('The processor definition cannot be published.');
    this.name = 'ProcessorDefinitionInvalidError';
  }
}

type ProcessorRow = typeof processorInstallations.$inferSelect;
type ProcessorVersionRow = typeof processorVersions.$inferSelect;

export interface ProcessorService {
  list(ownerId: string): Promise<readonly ProcessorResource[]>;
  get(ownerId: string, processorId: string): Promise<ProcessorResource>;
  getRunProvenance(
    ownerId: string,
    runId: string,
  ): Promise<ProcessorRunProvenance>;
  dryRun(
    ownerId: string,
    input: Readonly<{
      processorId?: string;
      versionId?: string;
      definition: ProcessorDefinitionDraft;
    }>,
  ): Promise<ProcessorDryRunResponse>;
  create(
    ownerId: string,
    input: Readonly<{
      id: string;
      versionId: string;
      key: string;
      name: string;
      purpose: string;
      definition: ProcessorDefinitionDraft;
    }>,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<Readonly<{ processor: ProcessorResource; replayed: boolean }>>;
  publishVersion(
    ownerId: string,
    processorId: string,
    expectedRevision: number,
    versionId: string,
    definition: ProcessorDefinitionDraft,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<Readonly<{ processor: ProcessorResource; replayed: boolean }>>;
  update(
    ownerId: string,
    processorId: string,
    expectedRevision: number,
    changes: Readonly<{
      name?: string;
      purpose?: string;
      enabled?: boolean;
      requirementMode?: 'optional' | 'required';
      currentVersionId?: string;
    }>,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<Readonly<{ processor: ProcessorResource; replayed: boolean }>>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function mapVersion(row: ProcessorVersionRow): ProcessorVersionResource {
  return {
    id: row.id,
    processorId: row.processorId,
    revision: row.revision,
    definition: processorDefinitionDraftSchema.parse(row.definition),
    instructionHash: row.instructionHash,
    outputSchemaHash: row.outputSchemaHash,
    promptTemplateHash: row.promptTemplateHash,
    ...(row.createdBy === null ? {} : { createdBy: row.createdBy }),
    createdAt: row.createdAt.toISOString(),
  };
}

function mapProcessor(
  row: ProcessorRow,
  versionRows: readonly ProcessorVersionRow[],
): ProcessorResource {
  const versions = versionRows
    .filter((version) => version.processorId === row.id)
    .map(mapVersion);
  return processorResourceSchema.parse({
    id: row.id,
    key: row.key,
    name: row.displayName,
    purpose: row.purpose,
    enabled: row.enabled,
    requirementMode: row.requirementMode,
    builtIn: row.builtIn,
    configRevision: row.configRevision,
    ...(row.currentVersionId === null
      ? {}
      : {
          currentVersionId: row.currentVersionId,
          currentVersion: versions.find(
            (version) => version.id === row.currentVersionId,
          ),
        }),
    versions,
    createdAt: row.installedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

async function publishedVersions(
  context: RepositoryContext,
): Promise<readonly PublishedProcessorVersion[]> {
  const rows = await context.select().from(processorVersions);
  return rows.map((row) => ({
    id: row.id,
    processorId: row.processorId,
    definition: processorDefinitionDraftSchema.parse(row.definition),
  }));
}

async function resource(
  context: RepositoryContext,
  processorId: string,
): Promise<ProcessorResource> {
  const [row] = await context
    .select()
    .from(processorInstallations)
    .where(eq(processorInstallations.id, processorId))
    .limit(1);
  if (row === undefined) throw new ProcessorNotFoundError();
  const versions = await context
    .select()
    .from(processorVersions)
    .where(eq(processorVersions.processorId, processorId))
    .orderBy(asc(processorVersions.revision));
  return mapProcessor(row, versions);
}

async function replay(
  context: RepositoryContext,
  ownerId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<ProcessorResource | undefined> {
  const [row] = await context
    .select()
    .from(processorApiIdempotency)
    .where(
      and(
        eq(processorApiIdempotency.ownerId, ownerId),
        eq(processorApiIdempotency.operation, operation),
        eq(processorApiIdempotency.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (row === undefined) return undefined;
  if (row.requestHash !== requestHash) {
    throw new ProcessorConflictError(
      'The idempotency key was reused with different processor input.',
    );
  }
  return processorResourceSchema.parse(row.response);
}

async function remember(
  context: RepositoryContext,
  input: Readonly<{
    ownerId: string;
    operation: string;
    idempotencyKey: string;
    requestHash: string;
    processor: ProcessorResource;
  }>,
): Promise<void> {
  await context.insert(processorApiIdempotency).values({
    ownerId: input.ownerId,
    operation: input.operation,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    processorId: input.processor.id,
    response: input.processor,
  });
}

function definitionHashes(definition: ProcessorDefinitionDraft) {
  const instructionHash = hash(definition.instructions);
  const outputSchemaHash = hash(definition.outputSchema);
  return {
    instructionHash,
    outputSchemaHash,
    promptTemplateHash: hash({
      instructionHash,
      outputSchemaHash,
      input: definition.input,
      dependencies: definition.dependencies,
      safetyPolicy: 'untrusted-journal-data-v1',
    }),
  };
}

async function insertVersion(
  context: RepositoryContext,
  input: Readonly<{
    id: string;
    processorId: string;
    revision: number;
    definition: ProcessorDefinitionDraft;
    ownerId: string;
  }>,
): Promise<void> {
  const hashes = definitionHashes(input.definition);
  await context.insert(processorVersions).values({
    id: input.id,
    processorId: input.processorId,
    revision: input.revision,
    semanticVersion: input.definition.semanticVersion,
    definition: input.definition,
    ...hashes,
    createdBy: input.ownerId,
  });
  if (input.definition.dependencies.length > 0) {
    await context.insert(processorVersionDependencies).values(
      input.definition.dependencies.map((dependency) => ({
        processorVersionId: input.id,
        upstreamVersionId: dependency.upstreamVersionId,
        outputSelector: dependency.outputSelector,
        acceptPartial: dependency.acceptPartial,
      })),
    );
  }
}

function assertValid(
  definition: ProcessorDefinitionDraft,
  versions: readonly PublishedProcessorVersion[],
  candidateVersionId: string,
  candidateProcessorId: string,
): void {
  const validation = validateProcessorDefinition(definition, {
    candidateVersionId,
    candidateProcessorId,
    publishedVersions: versions,
  });
  if (!validation.valid)
    throw new ProcessorDefinitionInvalidError(validation.issues);
}

export class PostgresProcessorService implements ProcessorService {
  public constructor(
    private readonly database: JournalDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async list(ownerId: string): Promise<readonly ProcessorResource[]> {
    void ownerId;
    const rows = await this.database
      .select()
      .from(processorInstallations)
      .orderBy(
        asc(processorInstallations.displayName),
        asc(processorInstallations.id),
      );
    const versions = await this.database
      .select()
      .from(processorVersions)
      .orderBy(asc(processorVersions.revision));
    return rows.map((row) => mapProcessor(row, versions));
  }

  public async get(
    ownerId: string,
    processorId: string,
  ): Promise<ProcessorResource> {
    void ownerId;
    return resource(this.database, processorId);
  }

  public async getRunProvenance(
    ownerId: string,
    runId: string,
  ): Promise<ProcessorRunProvenance> {
    const [row] = await this.database
      .select({ run: processorRuns, version: processorVersions })
      .from(processorRuns)
      .innerJoin(
        processorVersions,
        eq(processorVersions.id, processorRuns.processorVersionId),
      )
      .innerJoin(
        journalDays,
        eq(journalDays.id, processorRuns.targetJournalDayId),
      )
      .where(and(eq(processorRuns.id, runId), eq(journalDays.userId, ownerId)))
      .limit(1);
    if (row === undefined) throw new ProcessorNotFoundError();
    const inputs = await this.database
      .select()
      .from(processorRunInputs)
      .where(eq(processorRunInputs.runId, runId))
      .orderBy(asc(processorRunInputs.ordinal));
    const [result] =
      row.run.outputResultId === null
        ? []
        : await this.database
            .select()
            .from(processorResults)
            .where(eq(processorResults.id, row.run.outputResultId))
            .limit(1);
    const [reconciliation] =
      result === undefined
        ? []
        : await this.database
            .select()
            .from(processorReconciliations)
            .where(eq(processorReconciliations.runId, runId))
            .limit(1);
    const reconciliationOutcomes =
      reconciliation === undefined
        ? []
        : await this.database
            .select()
            .from(processorReconciliationOutcomes)
            .where(eq(processorReconciliationOutcomes.runId, runId))
            .orderBy(asc(processorReconciliationOutcomes.ordinal));
    return processorRunProvenanceSchema.parse({
      runId: row.run.id,
      processorId: row.run.processorId,
      processorVersionId: row.run.processorVersionId,
      processorSemanticVersion: row.version.semanticVersion,
      target: {
        scope: row.run.targetScope,
        journalDayId: row.run.targetJournalDayId,
        ...(row.run.targetContributionId === null
          ? {}
          : { contributionId: row.run.targetContributionId }),
      },
      status: row.run.status,
      attempt: row.run.attempt,
      ...(row.run.predecessorRunId === null
        ? {}
        : { predecessorRunId: row.run.predecessorRunId }),
      inputFingerprint: row.run.inputFingerprint,
      inputCompleteness: row.run.inputCompleteness,
      inputs: inputs.map((item) => ({
        ordinal: item.ordinal,
        label: item.label,
        kind: item.inputKind,
        ...(item.contributionRevisionId === null
          ? {}
          : { contributionRevisionId: item.contributionRevisionId }),
        ...(item.transcriptRevisionId === null
          ? {}
          : { transcriptRevisionId: item.transcriptRevisionId }),
        ...(item.processorResultId === null
          ? {}
          : { processorResultId: item.processorResultId }),
        ...(item.outputSelector === null
          ? {}
          : { outputSelector: item.outputSelector }),
        includedStartUtf16: item.includedStartUtf16,
        includedEndUtf16: item.includedEndUtf16,
        fullLengthUtf16: item.fullLengthUtf16,
        contentHash: item.contentHash,
        temporalContext: item.temporalContext,
      })),
      prompt: {
        assemblyVersion: row.run.promptAssemblyVersion,
        templateHash: row.run.promptTemplateHash,
        instructionHash: row.version.instructionHash,
        ...(row.run.effectiveMessagesHash === null
          ? {}
          : { effectiveMessagesHash: row.run.effectiveMessagesHash }),
      },
      requestedConfiguration: row.run.requestedConfiguration,
      ...(row.run.provider === null ? {} : { provider: row.run.provider }),
      ...(row.run.model === null ? {} : { model: row.run.model }),
      ...(row.run.effectiveConfiguration === null
        ? {}
        : { effectiveConfiguration: row.run.effectiveConfiguration }),
      ...(result === undefined
        ? {}
        : {
            result: {
              id: result.id,
              kind: result.kind,
              completeness: result.completeness,
              authority: result.authority,
              lifecycle: result.lifecycle,
              ...(result.staleAt === null
                ? {}
                : { staleAt: result.staleAt.toISOString() }),
              ...(result.staleReason === null
                ? {}
                : { staleReason: result.staleReason }),
              ...(reconciliation === undefined
                ? {}
                : {
                    reconciliation: {
                      strategy: reconciliation.strategy,
                      completeness: reconciliation.completeness,
                      inputHash: reconciliation.inputHash,
                      outcomes: reconciliationOutcomes.map((outcome) => ({
                        ordinal: outcome.ordinal,
                        logicalKey: outcome.logicalKey,
                        outcome: outcome.outcome,
                        artifactId: outcome.artifactId,
                        ...(outcome.versionId === null
                          ? {}
                          : { versionId: outcome.versionId }),
                        ...(outcome.priorVersionId === null
                          ? {}
                          : { priorVersionId: outcome.priorVersionId }),
                      })),
                    },
                  }),
              createdAt: result.createdAt.toISOString(),
            },
          }),
      queuedAt: row.run.queuedAt.toISOString(),
      ...(row.run.startedAt === null
        ? {}
        : { startedAt: row.run.startedAt.toISOString() }),
      ...(row.run.completedAt === null
        ? {}
        : { completedAt: row.run.completedAt.toISOString() }),
    });
  }

  public async dryRun(
    ownerId: string,
    input: Readonly<{
      processorId?: string;
      versionId?: string;
      definition: ProcessorDefinitionDraft;
    }>,
  ): Promise<ProcessorDryRunResponse> {
    void ownerId;
    const versions = await publishedVersions(this.database);
    const validation = validateProcessorDefinition(input.definition, {
      ...(input.versionId === undefined
        ? {}
        : { candidateVersionId: input.versionId }),
      ...(input.processorId === undefined
        ? {}
        : { candidateProcessorId: input.processorId }),
      publishedVersions: versions,
    });
    return processorDryRunResponseSchema.parse({
      valid: validation.valid,
      draftHash: hash(input.definition),
      issues: validation.issues,
      schemaComplexity: validation.schemaComplexity,
      resolvedDependencyCount: input.definition.dependencies.filter(
        (dependency) =>
          versions.some(
            (version) => version.id === dependency.upstreamVersionId,
          ),
      ).length,
      authoritative: false,
    });
  }

  public async create(
    ownerId: string,
    input: Readonly<{
      id: string;
      versionId: string;
      key: string;
      name: string;
      purpose: string;
      definition: ProcessorDefinitionDraft;
    }>,
    idempotencyKey: string,
    correlationId: string,
  ) {
    const operation = 'processor.create';
    const requestHash = hash(input);
    return inTransaction(this.database, async (transaction) => {
      const previous = await replay(
        transaction,
        ownerId,
        operation,
        idempotencyKey,
        requestHash,
      );
      if (previous !== undefined)
        return { processor: previous, replayed: true };
      const versions = await publishedVersions(transaction);
      assertValid(input.definition, versions, input.versionId, input.id);
      const [existingProcessor] = await transaction
        .select({ id: processorInstallations.id })
        .from(processorInstallations)
        .where(
          or(
            eq(processorInstallations.id, input.id),
            eq(processorInstallations.key, input.key),
          ),
        )
        .limit(1);
      if (existingProcessor !== undefined)
        throw new ProcessorConflictError(
          'The processor identity or key is already published.',
        );
      await transaction.insert(processorInstallations).values({
        id: input.id,
        key: input.key,
        displayName: input.name,
        purpose: input.purpose,
        enabled: input.definition.defaultEnabled,
        requirementMode: input.definition.requirementMode,
        builtIn: false,
      });
      await insertVersion(transaction, {
        id: input.versionId,
        processorId: input.id,
        revision: 1,
        definition: input.definition,
        ownerId,
      });
      await transaction
        .update(processorInstallations)
        .set({ currentVersionId: input.versionId, updatedAt: this.now() })
        .where(eq(processorInstallations.id, input.id));
      const created = await resource(transaction, input.id);
      await transaction.insert(auditEvents).values({
        id: createUuidV7<'audit-event'>(),
        action: 'processor.created',
        actorId: ownerId,
        entityType: 'processor',
        entityId: input.id,
        revisionId: input.versionId,
        correlationId,
        afterHash: hash(created),
        metadata: { builtIn: false, revision: 1 },
        occurredAt: this.now(),
      });
      await remember(transaction, {
        ownerId,
        operation,
        idempotencyKey,
        requestHash,
        processor: created,
      });
      return { processor: created, replayed: false };
    });
  }

  public async publishVersion(
    ownerId: string,
    processorId: string,
    expectedRevision: number,
    versionId: string,
    definition: ProcessorDefinitionDraft,
    idempotencyKey: string,
    correlationId: string,
  ) {
    const operation = `processor.publish.${processorId}`;
    const requestHash = hash({ expectedRevision, versionId, definition });
    return inTransaction(this.database, async (transaction) => {
      const previous = await replay(
        transaction,
        ownerId,
        operation,
        idempotencyKey,
        requestHash,
      );
      if (previous !== undefined)
        return { processor: previous, replayed: true };
      const current = await resource(transaction, processorId);
      if (current.configRevision !== expectedRevision)
        throw new ProcessorConflictError();
      const versions = await publishedVersions(transaction);
      assertValid(definition, versions, versionId, processorId);
      if (
        versions.some(
          (version) =>
            version.id === versionId ||
            (version.processorId === processorId &&
              version.definition.semanticVersion ===
                definition.semanticVersion),
        )
      ) {
        throw new ProcessorConflictError(
          'The processor version identity or semantic label is already published.',
        );
      }
      const [revisionRow] = await transaction
        .select({ value: max(processorVersions.revision) })
        .from(processorVersions)
        .where(eq(processorVersions.processorId, processorId));
      const revision = (revisionRow?.value ?? 0) + 1;
      await insertVersion(transaction, {
        id: versionId,
        processorId,
        revision,
        definition,
        ownerId,
      });
      const [advanced] = await transaction
        .update(processorInstallations)
        .set({
          currentVersionId: versionId,
          configRevision: expectedRevision + 1,
          updatedAt: this.now(),
        })
        .where(
          and(
            eq(processorInstallations.id, processorId),
            eq(processorInstallations.configRevision, expectedRevision),
          ),
        )
        .returning({ id: processorInstallations.id });
      if (advanced === undefined) throw new ProcessorConflictError();
      const updated = await resource(transaction, processorId);
      await transaction.insert(auditEvents).values({
        id: createUuidV7<'audit-event'>(),
        action: 'processor.version_published',
        actorId: ownerId,
        entityType: 'processor',
        entityId: processorId,
        revisionId: versionId,
        correlationId,
        beforeHash: hash(current),
        afterHash: hash(updated),
        metadata: { revision, semanticVersion: definition.semanticVersion },
        occurredAt: this.now(),
      });
      await remember(transaction, {
        ownerId,
        operation,
        idempotencyKey,
        requestHash,
        processor: updated,
      });
      return { processor: updated, replayed: false };
    });
  }

  public async update(
    ownerId: string,
    processorId: string,
    expectedRevision: number,
    changes: Readonly<{
      name?: string;
      purpose?: string;
      enabled?: boolean;
      requirementMode?: 'optional' | 'required';
      currentVersionId?: string;
    }>,
    idempotencyKey: string,
    correlationId: string,
  ) {
    const operation = `processor.update.${processorId}`;
    const requestHash = hash({ expectedRevision, changes });
    return inTransaction(this.database, async (transaction) => {
      const previous = await replay(
        transaction,
        ownerId,
        operation,
        idempotencyKey,
        requestHash,
      );
      if (previous !== undefined)
        return { processor: previous, replayed: true };
      const current = await resource(transaction, processorId);
      if (current.configRevision !== expectedRevision)
        throw new ProcessorConflictError();
      if (changes.currentVersionId !== undefined) {
        const selected = current.versions.find(
          (version) => version.id === changes.currentVersionId,
        );
        if (selected === undefined)
          throw new ProcessorConflictError(
            'The selected version belongs to another processor or does not exist.',
          );
      }
      const [changed] = await transaction
        .update(processorInstallations)
        .set({
          ...(changes.name === undefined ? {} : { displayName: changes.name }),
          ...(changes.purpose === undefined
            ? {}
            : { purpose: changes.purpose }),
          ...(changes.enabled === undefined
            ? {}
            : { enabled: changes.enabled }),
          ...(changes.requirementMode === undefined
            ? {}
            : { requirementMode: changes.requirementMode }),
          ...(changes.currentVersionId === undefined
            ? {}
            : { currentVersionId: changes.currentVersionId }),
          configRevision: expectedRevision + 1,
          updatedAt: this.now(),
        })
        .where(
          and(
            eq(processorInstallations.id, processorId),
            eq(processorInstallations.configRevision, expectedRevision),
          ),
        )
        .returning({ id: processorInstallations.id });
      if (changed === undefined) throw new ProcessorConflictError();
      const updated = await resource(transaction, processorId);
      await transaction.insert(auditEvents).values({
        id: createUuidV7<'audit-event'>(),
        action: 'processor.configuration_updated',
        actorId: ownerId,
        entityType: 'processor',
        entityId: processorId,
        correlationId,
        beforeHash: hash(current),
        afterHash: hash(updated),
        metadata: { changedFields: Object.keys(changes).sort().join(',') },
        occurredAt: this.now(),
      });
      await remember(transaction, {
        ownerId,
        operation,
        idempotencyKey,
        requestHash,
        processor: updated,
      });
      return { processor: updated, replayed: false };
    });
  }
}
