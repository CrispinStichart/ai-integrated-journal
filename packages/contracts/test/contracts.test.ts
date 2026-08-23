import { readFile } from 'node:fs/promises';

import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  conditionalMutationHeadersSchema,
  contractsPackageName,
  createCursorPageSchema,
  createContributionRequestSchema,
  createRecordingRequestSchema,
  createOpenApiDocument,
  createPersistedValueSchema,
  createSemanticValueSchema,
  cursorPaginationRequestSchema,
  editableResponseHeadersSchema,
  ERROR_CODES,
  eventPollResponseSchema,
  finalizeRecordingRequestSchema,
  healthDetailsResponseSchema,
  idempotencyResponseMetadataSchema,
  idempotentMutationHeadersSchema,
  lastEventIdSchema,
  persistedExtensibleValueSchema,
  problemDetailsSchema,
  processorDefinitionDraftSchema,
  processorDryRunResponseSchema,
  semanticJsonValueSchema,
  serializeOpenApiDocument,
  sseEventEnvelopeSchema,
  strongEtagSchema,
  unsupportedSseEventEnvelopeSchema,
  utcInstantSchema,
  uuidV7Schema,
} from '../src/index.js';

const UUID_V7 = '01890f2e-7c10-7abc-8def-0123456789ab';
const INSTANT = '2026-08-15T12:34:56.123456789Z';

describe('CONTRACT ADR-0002 shared API contracts', () => {
  it('owns the package and validates wire primitives strictly', () => {
    expect(contractsPackageName).toBe('@journal/contracts');
    expect(uuidV7Schema.parse(UUID_V7)).toBe(UUID_V7);
    expect(uuidV7Schema.safeParse(UUID_V7.toUpperCase()).success).toBe(false);
    expect(utcInstantSchema.parse(INSTANT)).toBe(INSTANT);
    expect(
      utcInstantSchema.safeParse('2026-08-15T14:34:56+02:00').success,
    ).toBe(false);
  });

  it('parses bounded cursor requests and typed responses', () => {
    expect(cursorPaginationRequestSchema.parse({})).toEqual({ limit: 50 });
    expect(
      cursorPaginationRequestSchema.parse({ cursor: 'next_123', limit: '10' }),
    ).toEqual({ cursor: 'next_123', limit: 10 });
    expect(
      cursorPaginationRequestSchema.safeParse({ cursor: 'not base64!' })
        .success,
    ).toBe(false);
    expect(
      cursorPaginationRequestSchema.safeParse({ limit: 101 }).success,
    ).toBe(false);

    const pageSchema = createCursorPageSchema(z.string());
    expect(
      pageSchema.parse({
        items: ['one'],
        page: { hasMore: true, nextCursor: 'next_123' },
      }),
    ).toEqual({
      items: ['one'],
      page: { hasMore: true, nextCursor: 'next_123' },
    });
    expect(
      pageSchema.safeParse({
        items: ['one'],
        page: { hasMore: false },
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it('validates idempotency and strong ETag metadata', () => {
    expect(
      idempotentMutationHeadersSchema.parse({
        'idempotency-key': 'offline-01890f2e',
      }),
    ).toEqual({ 'idempotency-key': 'offline-01890f2e' });
    expect(
      conditionalMutationHeadersSchema.parse({
        'idempotency-key': 'offline-01890f2e',
        'if-match': '"revision-4"',
      }),
    ).toEqual({
      'idempotency-key': 'offline-01890f2e',
      'if-match': '"revision-4"',
    });
    expect(
      editableResponseHeadersSchema.parse({ etag: '"revision-4"' }),
    ).toEqual({ etag: '"revision-4"' });
    expect(
      idempotencyResponseMetadataSchema.parse({
        key: 'offline-01890f2e',
        replayed: true,
      }),
    ).toEqual({ key: 'offline-01890f2e', replayed: true });
    expect(strongEtagSchema.safeParse('W/"revision-4"').success).toBe(false);
    expect(
      idempotentMutationHeadersSchema.safeParse({
        'idempotency-key': 'has whitespace',
      }).success,
    ).toBe(false);
  });

  it('DATA-010 DATA-013 validates typed and nudge-response provenance', () => {
    const base = {
      contributionId: UUID_V7,
      revisionId: '01890f2e-7c10-7abc-8def-0123456789ac',
      proposedJournalDayId: '01890f2e-7c10-7abc-8def-0123456789ad',
      text: 'Source text',
      capturedAt: INSTANT,
      capturedTimezone: 'America/New_York',
      journalTimezone: 'America/New_York',
      journalDate: '2026-08-15',
      journalDateAssignment: 'default' as const,
    };
    expect(
      createContributionRequestSchema.safeParse({
        ...base,
        sourceType: 'typed_text',
      }).success,
    ).toBe(true);
    expect(
      createContributionRequestSchema.safeParse({
        ...base,
        sourceType: 'nudge_response',
      }).success,
    ).toBe(false);
    expect(
      createContributionRequestSchema.safeParse({
        ...base,
        sourceType: 'nudge_response',
        elicitingNudgeId: '01890f2e-7c10-7abc-8def-0123456789ae',
      }).success,
    ).toBe(true);
    expect(
      createContributionRequestSchema.safeParse({
        ...base,
        sourceType: 'typed_text',
        elicitingNudgeId: '01890f2e-7c10-7abc-8def-0123456789ae',
      }).success,
    ).toBe(false);
    expect(
      createContributionRequestSchema.safeParse({
        ...base,
        sourceType: 'typed_text',
        capturedTimezone: 'Not/A_Timezone',
      }).success,
    ).toBe(false);
  });

  it('parses RFC 9457 details with stable, extensible codes', () => {
    const problem = {
      type: 'https://journal.local/problems/validation-failed',
      title: 'Request validation failed',
      status: 422,
      code: 'validation_failed',
      correlationId: UUID_V7,
      invalidParameters: [
        { name: 'date', location: 'body', reason: 'Invalid date' },
      ],
      retryable: false,
    };
    expect(problemDetailsSchema.parse(problem)).toEqual(problem);
    expect(ERROR_CODES).toContain('server_storage_exhausted');
    expect(
      problemDetailsSchema.parse({ ...problem, code: 'future_error' }),
    ).toEqual({ ...problem, code: 'future_error' });
    expect(
      problemDetailsSchema.safeParse({ ...problem, code: 'Not Stable' })
        .success,
    ).toBe(false);
    expect(
      problemDetailsSchema.safeParse({ ...problem, status: 200 }).success,
    ).toBe(false);
  });

  it('validates replayable versioned SSE envelopes', () => {
    const event = {
      eventId: UUID_V7,
      eventType: 'processing-run.changed',
      schemaVersion: 1,
      occurredAt: INSTANT,
      payload: { runId: UUID_V7, status: 'running' },
    };
    expect(sseEventEnvelopeSchema.parse(event)).toEqual(event);
    expect(lastEventIdSchema.parse(UUID_V7)).toBe(UUID_V7);
    expect(
      sseEventEnvelopeSchema.safeParse({ ...event, schemaVersion: 2 }).success,
    ).toBe(false);
    expect(
      unsupportedSseEventEnvelopeSchema.parse({ ...event, schemaVersion: 2 }),
    ).toEqual({ ...event, schemaVersion: 2 });
    expect(unsupportedSseEventEnvelopeSchema.safeParse(event).success).toBe(
      false,
    );
    expect(
      eventPollResponseSchema.parse({ events: [event], nextEventId: UUID_V7 }),
    ).toEqual({ events: [event], nextEventId: UUID_V7 });
  });

  it('API-OPS distinguishes dependency state from overall readiness', () => {
    const details = {
      status: 'healthy',
      checkedAt: INSTANT,
      dependencies: {
        postgresql: { status: 'healthy' },
        providers: { status: 'not_configured' },
      },
    };

    expect(healthDetailsResponseSchema.parse(details)).toEqual(details);
    expect(
      healthDetailsResponseSchema.safeParse({
        ...details,
        dependencies: { storage: { status: 'maybe' } },
      }).success,
    ).toBe(false);
  });
});

describe('CONTRACT DATA-030 PROC-001 PROC-006 processor definitions', () => {
  const definition = {
    semanticVersion: '1.0.0',
    kind: 'observation_extractor',
    instructions: 'Grounded data only.',
    input: { scope: 'journal_day', selectors: ['typed_text'] },
    dependencies: [],
    outputSchemaVersion: '1.0.0',
    outputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    reconciliation: { strategy: 'replace_scope' },
    requirementMode: 'optional',
    defaultEnabled: false,
    nudgePolicy: { enabled: false, allowNotApplicable: true },
    capabilityRequirements: ['structured_generation'],
    allowPartialInputs: false,
    resourceLimits: {
      maxPromptChars: 12000,
      maxInputChars: 64000,
      maxRuntimeMs: 30000,
      maxResultBytes: 65536,
    },
    outputSafety: {
      mode: 'data_only',
      allowCodeExecution: false,
      allowToolCalls: false,
      allowSql: false,
      allowHtml: false,
    },
  };

  it('[DATA-030][PROC-003][PROC-004][PROC-006] preserves every behavior-affecting definition field', () => {
    expect(processorDefinitionDraftSchema.parse(definition)).toEqual(
      definition,
    );
    expect(
      processorDefinitionDraftSchema.safeParse({
        ...definition,
        outputSafety: { ...definition.outputSafety, allowHtml: true },
      }).success,
    ).toBe(false);
    expect(
      processorDefinitionDraftSchema.safeParse({
        ...definition,
        resourceLimits: { ...definition.resourceLimits, maxRuntimeMs: 120001 },
      }).success,
    ).toBe(false);
  });

  it('[PROC-006] labels dry-run results non-authoritative', () => {
    expect(
      processorDryRunResponseSchema.parse({
        valid: true,
        draftHash: 'a'.repeat(64),
        issues: [],
        schemaComplexity: { depth: 1, nodes: 1 },
        resolvedDependencyCount: 0,
        authoritative: false,
      }).authoritative,
    ).toBe(false);
  });
});

describe('CONTRACT DATA-032 DATA-033 persisted extensible values', () => {
  it('preserves unknown opaque payload fields and future schema versions', () => {
    const value = {
      schemaVersion: 9,
      kind: 'processor.daily-summary',
      payload: { count: 0, newOptional: { retained: true } },
    };
    expect(persistedExtensibleValueSchema.parse(value)).toEqual(value);
    expect(
      persistedExtensibleValueSchema.safeParse({
        ...value,
        topLevelDrift: true,
      }).success,
    ).toBe(false);
  });

  it('builds strict current-version persisted contracts', () => {
    const schema = createPersistedValueSchema(
      'test.counter',
      z.strictObject({ count: z.number().int() }),
    );
    expect(
      schema.parse({
        schemaVersion: 1,
        kind: 'test.counter',
        payload: { count: 0 },
      }),
    ).toEqual({
      schemaVersion: 1,
      kind: 'test.counter',
      payload: { count: 0 },
    });
    expect(
      schema.safeParse({
        schemaVersion: 2,
        kind: 'test.counter',
        payload: { count: 0 },
      }).success,
    ).toBe(false);
  });

  it('keeps unknown, zero, none, neutral, uncertain, and N/A distinct', () => {
    const numberValue = createSemanticValueSchema(z.number());
    const values = [
      { state: 'unknown' },
      { state: 'known', value: 0 },
      { state: 'none' },
      { state: 'neutral' },
      { state: 'uncertain', value: 0, confidence: 0 },
      { state: 'not_applicable' },
    ];
    expect(values.map((value) => numberValue.parse(value))).toEqual(values);
    expect(numberValue.safeParse({ state: 'known' }).success).toBe(false);
    expect(
      numberValue.safeParse({ state: 'uncertain', confidence: 1.1 }).success,
    ).toBe(false);
    expect(semanticJsonValueSchema.safeParse(null).success).toBe(false);
  });
});

describe('CONTRACT CAP-002 CAP-004 CAP-005 recording protocol', () => {
  it('validates preallocated identities, MIME metadata, and temporal context', () => {
    const input = {
      recordingId: UUID_V7,
      contributionId: UUID_V7,
      uploadId: UUID_V7,
      proposedJournalDayId: UUID_V7,
      mimeType: 'audio/webm;codecs=opus',
      codec: 'opus',
      capturedAt: INSTANT,
      capturedTimezone: 'America/New_York',
      journalTimezone: 'America/New_York',
      journalDate: '2026-08-15',
      journalDateAssignment: 'default',
    };
    expect(createRecordingRequestSchema.parse(input)).toEqual(input);
    expect(
      createRecordingRequestSchema.safeParse({
        ...input,
        mimeType: 'text/plain',
      }).success,
    ).toBe(false);
  });

  it('uses decimal aggregate values and a bounded manifest summary', () => {
    const summary = {
      manifestVersion: 1,
      chunkCount: '9007199254740993',
      totalBytes: '90071992547409930',
      manifestSha256: 'a'.repeat(64),
      finalSha256: 'b'.repeat(64),
    };
    expect(finalizeRecordingRequestSchema.parse(summary)).toEqual(summary);
    expect(
      finalizeRecordingRequestSchema.safeParse({
        ...summary,
        chunkCount: 2,
      }).success,
    ).toBe(false);
    expect(
      finalizeRecordingRequestSchema.safeParse({
        ...summary,
        totalBytes: '01',
      }).success,
    ).toBe(false);
  });
});

describe('CONTRACT ADR-0002 generated OpenAPI 3.1', () => {
  it('publishes all foundational component schemas under /api/v1', () => {
    const document = createOpenApiDocument();
    expect(document.openapi).toBe('3.1.1');
    expect(document.servers).toEqual([{ url: 'http://localhost:3000' }]);
    expect(document.components).toMatchObject({
      schemas: {
        ProblemDetails: expect.any(Object),
        SseEventEnvelope: expect.any(Object),
        PersistedExtensibleValue: expect.any(Object),
      },
    });
  });

  it('matches the checked-in generated artifact', async () => {
    const generated = await readFile(
      new URL('../openapi/openapi.json', import.meta.url),
      'utf8',
    );
    expect(generated).toBe(serializeOpenApiDocument());
  });
});
