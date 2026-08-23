// @vitest-environment jsdom

import type {
  ProcessorDefinitionDraft,
  ProcessorResource,
} from '@journal/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createProcessor,
  dryRunProcessorDefinition,
  listProcessors,
  ProcessorApiError,
  publishProcessorVersion,
  updateProcessor,
} from '../src/processor/api';

const PROCESSOR_ID = '019c5b90-0000-7000-8000-000000000021';
const VERSION_ID = '019c5b90-0000-7000-8000-000000000022';
const NOW = '2026-08-23T12:00:00.000Z';
const definition: ProcessorDefinitionDraft = {
  semanticVersion: '1.0.0',
  kind: 'observation_extractor',
  instructions: 'Grounded data only.',
  input: { scope: 'journal_day', selectors: ['typed_text'] },
  dependencies: [],
  outputSchemaVersion: '1.0.0',
  outputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
const processor: ProcessorResource = {
  id: PROCESSOR_ID,
  key: 'exercise',
  name: 'Exercise',
  purpose: 'Exercise observations.',
  enabled: false,
  requirementMode: 'optional',
  builtIn: false,
  configRevision: 1,
  versions: [],
  createdAt: NOW,
  updatedAt: NOW,
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('processor API client', () => {
  it('[PROC-001][PROC-002] validates list and mutation responses and sends conditional headers', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ items: [processor] }))
      .mockResolvedValueOnce(
        response({
          processor: { ...processor, enabled: true, configRevision: 2 },
          idempotency: { key: 'update-1', replayed: false },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    expect(await listProcessors()).toEqual([processor]);
    await updateProcessor({
      csrfToken: 'csrf',
      idempotencyKey: 'update-1',
      processorId: PROCESSOR_ID,
      revision: 1,
      changes: { enabled: true },
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/v1/processors/${PROCESSOR_ID}`,
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({
          'if-match': '"processor-1"',
          'idempotency-key': 'update-1',
          'x-csrf-token': 'csrf',
        }),
      }),
    );
  });

  it('[PROC-006] supports create, dry-run, and exact version publication contracts', async () => {
    const mutation = {
      processor,
      idempotency: { key: 'key', replayed: false },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          valid: true,
          draftHash: 'd'.repeat(64),
          issues: [],
          schemaComplexity: { depth: 1, nodes: 1 },
          resolvedDependencyCount: 0,
          authoritative: false,
        }),
      )
      .mockResolvedValueOnce(response(mutation, 201))
      .mockResolvedValueOnce(response(mutation, 201));
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await dryRunProcessorDefinition({ csrfToken: 'csrf', definition }),
    ).toMatchObject({ authoritative: false });
    await createProcessor({
      csrfToken: 'csrf',
      idempotencyKey: 'key',
      id: PROCESSOR_ID,
      versionId: VERSION_ID,
      key: 'exercise',
      name: 'Exercise',
      purpose: 'Exercise observations.',
      definition,
    });
    await publishProcessorVersion({
      csrfToken: 'csrf',
      idempotencyKey: 'key',
      processorId: PROCESSOR_ID,
      revision: 1,
      versionId: VERSION_ID,
      definition,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('[STATE-003] maps problem details without exposing response content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response(
          {
            type: 'about:blank',
            title: 'Invalid definition',
            status: 422,
            code: 'processor_definition_invalid',
            correlationId: VERSION_ID,
          },
          422,
        ),
      ),
    );
    await expect(listProcessors()).rejects.toMatchObject<
      Partial<ProcessorApiError>
    >({
      status: 422,
      code: 'processor_definition_invalid',
      message: 'Invalid definition',
    });
  });
});
