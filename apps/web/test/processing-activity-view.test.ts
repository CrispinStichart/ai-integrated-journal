// @vitest-environment jsdom

import type {
  ProcessorDefinitionDraft,
  ProcessorResource,
  ReprocessingBatch,
} from '@journal/contracts';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import axe from 'axe-core';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  history: vi.fn(),
  listProcessors: vi.fn(),
  preview: vi.fn(),
  start: vi.fn(),
}));

vi.mock('../src/auth', () => ({
  useAuthentication: () => ({ status: ref({ csrfToken: 'csrf-token' }) }),
}));
vi.mock('../src/journal/api', () => ({
  createUuidV7: () => '019c5b90-0000-7000-8000-000000000099',
}));
vi.mock('../src/processor/api', () => ({
  listProcessors: mocks.listProcessors,
}));
vi.mock('../src/reprocessing/api', () => ({
  cancelReprocessing: mocks.cancel,
  listReprocessingBatches: mocks.history,
  previewReprocessing: mocks.preview,
  startReprocessing: mocks.start,
}));

import ProcessingActivityView from '../src/views/ProcessingActivityView.vue';

const PROCESSOR_ID = '019c5b90-0000-7000-8000-000000000021';
const VERSION_ID = '019c5b90-0000-7000-8000-000000000022';
const BATCH_ID = '019c5b90-0000-7000-8000-000000000023';
const NOW = '2026-08-23T12:00:00.000Z';
const definition: ProcessorDefinitionDraft = {
  semanticVersion: '1.0.0',
  kind: 'observation_extractor',
  instructions: 'Grounded fixture.',
  input: { scope: 'journal_day', selectors: ['typed_text'] },
  dependencies: [],
  outputSchemaVersion: '1.0.0',
  outputSchema: { type: 'object', properties: {}, additionalProperties: false },
  reconciliation: { strategy: 'replace_scope' },
  requirementMode: 'optional',
  defaultEnabled: true,
  nudgePolicy: { enabled: false, allowNotApplicable: true },
  capabilityRequirements: ['structured_generation'],
  allowPartialInputs: false,
  resourceLimits: {
    maxPromptChars: 1024,
    maxInputChars: 4096,
    maxRuntimeMs: 5_000,
    maxResultBytes: 4096,
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
  key: 'fixture',
  name: 'Fixture',
  purpose: 'Fixture processor.',
  enabled: true,
  requirementMode: 'optional',
  builtIn: false,
  configRevision: 1,
  currentVersionId: VERSION_ID,
  currentVersion: {
    id: VERSION_ID,
    processorId: PROCESSOR_ID,
    revision: 1,
    definition,
    instructionHash: 'a'.repeat(64),
    outputSchemaHash: 'b'.repeat(64),
    promptTemplateHash: 'c'.repeat(64),
    createdAt: NOW,
  },
  versions: [
    {
      id: VERSION_ID,
      processorId: PROCESSOR_ID,
      revision: 1,
      definition,
      instructionHash: 'a'.repeat(64),
      outputSchemaHash: 'b'.repeat(64),
      promptTemplateHash: 'c'.repeat(64),
      createdAt: NOW,
    },
  ],
  createdAt: NOW,
  updatedAt: NOW,
};
const versionBasis = {
  mode: 'current' as const,
  versions: [
    {
      processorId: PROCESSOR_ID,
      processorName: 'Fixture',
      processorVersionId: VERSION_ID,
      semanticVersion: '1.0.0',
      inputScope: 'journal_day' as const,
      providerOperationsPerRun: 1,
    },
  ],
};
const impact = {
  journalDayCount: 1,
  contributionCount: 1,
  runCount: 1,
  approximateProviderOperationCount: 1,
  staleArtifactCount: 1,
  manualOverrideCount: 1,
};
const batch: ReprocessingBatch = {
  id: BATCH_ID,
  revision: 1,
  status: 'queued',
  target: { scope: 'journal_day', journalDate: '2026-08-23' },
  versionBasis,
  impact,
  progress: {
    total: 1,
    queued: 1,
    running: 0,
    succeeded: 0,
    failed: 0,
    canceled: 0,
    percent: 0,
  },
  createdAt: NOW,
  updatedAt: NOW,
};

function mountView() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    wrapper: mount(ProcessingActivityView, {
      attachTo: document.body,
      global: { plugins: [[VueQueryPlugin, { queryClient }]] },
    }),
    queryClient,
  };
}

describe('Processing activity UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperties(HTMLDialogElement.prototype, {
      close: {
        configurable: true,
        value(this: HTMLDialogElement) {
          this.removeAttribute('open');
        },
      },
      showModal: {
        configurable: true,
        value(this: HTMLDialogElement) {
          this.setAttribute('open', '');
        },
      },
    });
    mocks.listProcessors.mockResolvedValue([processor]);
    mocks.history.mockResolvedValue([batch]);
    mocks.preview.mockResolvedValue({
      target: batch.target,
      versionBasis,
      impact,
      impactFingerprint: 'd'.repeat(64),
      warnings: ['1 active manual override will remain authoritative.'],
      expiresAt: NOW,
    });
    mocks.start.mockResolvedValue(batch);
    mocks.cancel.mockResolvedValue({
      ...batch,
      revision: 2,
      status: 'canceled',
      progress: {
        ...batch.progress,
        queued: 0,
        canceled: 1,
        percent: 100,
      },
      cancelRequestedAt: NOW,
    });
  });

  it('[EDIT-003][EDIT-004][EDIT-008][STATE-001] exposes every scope, explicit version basis, progress, and audit history accessibly', async () => {
    const { wrapper, queryClient } = mountView();
    await flushPromises();
    expect(
      wrapper
        .get('#reprocessing-scope')
        .findAll('option')
        .map((option) => option.text()),
    ).toEqual([
      'Contribution',
      'Journal Day',
      'Date range',
      'Processor',
      'Processor version',
    ]);
    expect(wrapper.text()).toContain('Current enabled versions');
    expect(wrapper.text()).toContain('Exact processor-version basis');
    expect(wrapper.text()).toContain('0% complete');
    expect((await axe.run(wrapper.element)).violations).toEqual([]);
    queryClient.clear();
    wrapper.unmount();
  });

  it('[EDIT-004][EDIT-006] previews provider impact and protected manual authority before confirmation', async () => {
    const { wrapper, queryClient } = mountView();
    await flushPromises();
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(mocks.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ scope: 'journal_day' }),
        versionBasis: { mode: 'current' },
      }),
      'csrf-token',
    );
    expect(wrapper.text()).toContain('Approx. provider operations');
    expect(wrapper.text()).toContain(
      '1 active manual override will remain authoritative.',
    );
    const confirm = wrapper
      .findAll('button')
      .find((button) => button.text() === 'Confirm and start');
    if (confirm === undefined) throw new Error('Confirmation button missing.');
    await confirm.trigger('click');
    await flushPromises();
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        impactFingerprint: 'd'.repeat(64),
        idempotencyKey: expect.stringContaining('reprocess-start-'),
      }),
    );
    queryClient.clear();
    wrapper.unmount();
  });

  it('[STATE-001][STATE-004][EDIT-005] cancels only remaining work and retains the batch in history', async () => {
    const { wrapper, queryClient } = mountView();
    await flushPromises();
    const cancelButton = wrapper
      .findAll('button')
      .find((button) => button.text() === 'Cancel remaining work');
    if (cancelButton === undefined) throw new Error('Cancel button missing.');
    await cancelButton.trigger('click');
    await flushPromises();
    expect(mocks.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ batch, csrfToken: 'csrf-token' }),
    );
    expect(wrapper.text()).toContain('Cancellation recorded');
    expect(wrapper.text()).toContain('canceled');
    queryClient.clear();
    wrapper.unmount();
  });
});
