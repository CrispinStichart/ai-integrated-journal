// @vitest-environment jsdom

import type { ArtifactResource } from '@journal/contracts';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import axe from 'axe-core';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  edit: vi.fn(),
  list: vi.fn(),
  merge: vi.fn(),
}));
vi.mock('../src/auth', () => ({
  useAuthentication: () => ({ status: ref({ csrfToken: 'csrf-token' }) }),
}));
vi.mock('../src/journal/api', () => ({
  createUuidV7: () => '019c5b90-0000-7000-8000-000000000099',
}));
vi.mock('../src/artifact/api', () => ({
  editArtifact: mocks.edit,
  listArtifacts: mocks.list,
  mergeArtifacts: mocks.merge,
}));

import ArtifactReviewPanel from '../src/components/ArtifactReviewPanel.vue';

const DAY_ID = '019c5b90-0000-7000-8000-000000000021';
const ARTIFACT_ID = '019c5b90-0000-7000-8000-000000000022';
const CANDIDATE_ID = '019c5b90-0000-7000-8000-000000000023';
const NOW = '2026-08-23T18:00:00.000Z';

function artifact(id = ARTIFACT_ID): ArtifactResource {
  return {
    id,
    processorId: '019c5b90-0000-7000-8000-000000000024',
    journalDayId: DAY_ID,
    logicalKey: 'string:water',
    kind: 'observation',
    revision: 2,
    active: true,
    deleted: false,
    authority: 'manual',
    payload: { amount: 2, context: 'breakfast' },
    manualOperation: 'correct',
    overridePaths: ['/amount'],
    generatedCandidate: {
      id: CANDIDATE_ID,
      versionId: CANDIDATE_ID,
      payload: { amount: 3, context: 'lunch' },
      payloadHash: 'b'.repeat(64),
      status: 'reviewable',
      conflictsWithManualVersionId: '019c5b90-0000-7000-8000-000000000025',
      createdAt: NOW,
    },
    candidates: [
      {
        id: CANDIDATE_ID,
        versionId: CANDIDATE_ID,
        payload: { amount: 3, context: 'lunch' },
        payloadHash: 'b'.repeat(64),
        status: 'reviewable',
        conflictsWithManualVersionId: '019c5b90-0000-7000-8000-000000000025',
        createdAt: NOW,
      },
    ],
    evidence: [],
    history: [
      {
        id: '019c5b90-0000-7000-8000-000000000026',
        revision: 1,
        authority: 'generated',
        lifecycle: 'superseded',
        payload: { amount: 1, context: 'breakfast' },
        payloadHash: 'a'.repeat(64),
        processorVersionId: '019c5b90-0000-7000-8000-000000000027',
        sourceResultId: '019c5b90-0000-7000-8000-000000000028',
        overridePaths: [],
        createdAt: NOW,
      },
      {
        id: '019c5b90-0000-7000-8000-000000000025',
        revision: 1,
        authority: 'manual',
        lifecycle: 'active',
        payload: { amount: 2, context: 'breakfast' },
        payloadHash: 'c'.repeat(64),
        manualOperation: 'correct',
        overridePaths: ['/amount'],
        createdAt: NOW,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function foodArtifact(): ArtifactResource {
  const {
    manualOperation: _manualOperation,
    generatedCandidate: _generatedCandidate,
    ...base
  } = artifact();
  void _manualOperation;
  void _generatedCandidate;
  return {
    ...base,
    authority: 'generated',
    overridePaths: [],
    candidates: [],
    logicalKey: 'string:lunch-pizza',
    payload: {
      eventKey: 'lunch-pizza',
      description: 'pepperoni pizza',
      classification: 'food',
      ownership: 'self',
      certainty: 'known',
      meal: 'lunch',
      quantity: {
        text: 'two slices',
        kind: 'exact',
        normalizedQuantity: { value: 2, unit: 'slice' },
      },
      evidenceOrdinals: [0, 1],
    },
    evidence: [
      {
        id: '019c5b90-0000-7000-8000-000000000030',
        ordinal: 0,
        sourceLabel: 'typed_text:019c5b90-0000-7000-8000-000000000031',
        sourceType: 'typed_text',
        sourceRevisionId: '019c5b90-0000-7000-8000-000000000031',
        normalization: 'NFC_LF_V1',
        offsetUnit: 'utf16_code_unit',
        startUtf16: 0,
        endUtf16: 21,
        quote: 'I had pizza for lunch',
        quoteHash: 'd'.repeat(64),
        resolutionStatus: 'resolved',
      },
      {
        id: '019c5b90-0000-7000-8000-000000000032',
        ordinal: 1,
        sourceLabel:
          'corrected_transcript:019c5b90-0000-7000-8000-000000000033',
        sourceType: 'corrected_transcript',
        sourceRevisionId: '019c5b90-0000-7000-8000-000000000033',
        normalization: 'NFC_LF_V1',
        offsetUnit: 'utf16_code_unit',
        startUtf16: 0,
        endUtf16: 36,
        quote: 'it was two slices of pepperoni pizza',
        quoteHash: 'e'.repeat(64),
        resolutionStatus: 'resolved',
        audioRange: { startMs: 1200, endMs: 4400 },
      },
    ],
    provenance: {
      resultId: '019c5b90-0000-7000-8000-000000000034',
      runId: '019c5b90-0000-7000-8000-000000000035',
      processorKey: 'food-and-drink',
      processorName: 'Food and drink',
      processorVersionId: '019c5b90-0000-7000-8000-000000000021',
      semanticVersion: '2.0.0',
      instructionHash: 'a'.repeat(64),
      promptTemplateHash: 'b'.repeat(64),
      provider: { id: 'fixture', displayName: 'Fixture provider' },
      model: { id: 'fixture-model' },
      processingTimeMilliseconds: 12,
    },
  };
}

function mountPanel(items: readonly ArtifactResource[] = [artifact()]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  mocks.list.mockResolvedValue(items);
  mocks.edit.mockResolvedValue(items);
  mocks.merge.mockResolvedValue(items);
  const wrapper = mount(ArtifactReviewPanel, {
    props: { journalDayId: DAY_ID },
    attachTo: document.body,
    global: { plugins: [[VueQueryPlugin, { queryClient }]] },
  });
  return { wrapper, queryClient };
}

function button(wrapper: ReturnType<typeof mount>, label: string) {
  const found = wrapper
    .findAll('button')
    .find((item) => item.text().includes(label));
  if (found === undefined) throw new Error(`Missing button: ${label}`);
  return found;
}

describe('artifact review UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });

  it('[ARCH-004][PROV-004][EDIT-007][AC-032] labels manual authority without color alone and exposes generated conflicts plus immutable provenance accessibly', async () => {
    const { wrapper, queryClient } = mountPanel();
    await flushPromises();
    expect(wrapper.text()).toContain('Manual authority');
    expect(wrapper.text()).toContain('Generated candidate needs review');
    expect(wrapper.text()).toContain('Your manual value is still active');
    expect(wrapper.text()).toContain('Revision and provenance history');
    expect((await axe.run(wrapper.element)).violations).toEqual([]);
    queryClient.clear();
    wrapper.unmount();
  });

  it('[FOOD-003][PROV-001][PROV-004][AC-021] presents one readable food card with exact evidence and processor lineage', async () => {
    const { wrapper, queryClient } = mountPanel([foodArtifact()]);
    await flushPromises();
    expect(wrapper.text()).toContain('pepperoni pizza');
    expect(wrapper.text()).toContain('two slices (2 slice)');
    expect(wrapper.text()).toContain('Consumed by you');
    expect(wrapper.text()).toContain('Evidence and processing details');
    expect(wrapper.text()).toContain('I had pizza for lunch');
    expect(wrapper.text()).toContain('it was two slices of pepperoni pizza');
    expect(wrapper.text()).toContain('Audio 1200–4400 ms');
    expect(wrapper.text()).toContain('Food and drink version 2.0.0');
    expect(wrapper.text()).toContain('Fixture provider / fixture-model');
    expect((await axe.run(wrapper.element)).violations).toEqual([]);
    queryClient.clear();
    wrapper.unmount();
  });

  it('[FOOD-007][EDIT-006] dispatches explicit confirm, split, candidate adoption, and candidate dismissal commands', async () => {
    const { wrapper, queryClient } = mountPanel();
    await flushPromises();
    await button(wrapper, 'Confirm').trigger('click');
    await flushPromises();
    await button(wrapper, 'Split fields').trigger('click');
    await flushPromises();
    await button(wrapper, 'Adopt as manual').trigger('click');
    await flushPromises();
    await button(wrapper, 'Dismiss suggestion').trigger('click');
    await flushPromises();
    expect(mocks.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: ARTIFACT_ID,
        revision: 2,
        edit: { operation: 'confirm' },
      }),
    );
    expect(mocks.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        edit: expect.objectContaining({
          operation: 'split',
          results: expect.arrayContaining([
            expect.objectContaining({ payload: { amount: 2 } }),
          ]),
        }),
      }),
    );
    expect(mocks.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        edit: { operation: 'adopt_candidate', candidateId: CANDIDATE_ID },
      }),
    );
    expect(mocks.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        edit: { operation: 'dismiss_candidate', candidateId: CANDIDATE_ID },
      }),
    );
    queryClient.clear();
    wrapper.unmount();
  });

  it('[EDIT-005][EDIT-006] edits JSON through a confirmation dialog and preserves invalid drafts for correction', async () => {
    const { wrapper, queryClient } = mountPanel();
    await flushPromises();
    await button(wrapper, 'Correct').trigger('click');
    await wrapper.get('textarea').setValue('{invalid');
    await button(wrapper, 'Save correction').trigger('click');
    expect(wrapper.text()).toContain('Expected property name');
    expect(mocks.edit).not.toHaveBeenCalled();
    await wrapper.get('textarea').setValue('{"amount":4,"context":"dinner"}');
    await button(wrapper, 'Save correction').trigger('click');
    await flushPromises();
    expect(mocks.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        edit: {
          operation: 'correct',
          overrides: [{ path: '', value: { amount: 4, context: 'dinner' } }],
        },
      }),
    );
    queryClient.clear();
    wrapper.unmount();
  });

  it('[FOOD-007] requires explicit confirmation before delete and merge', async () => {
    const second = {
      ...artifact('019c5b90-0000-7000-8000-000000000029'),
      logicalKey: 'string:coffee',
      generatedCandidate: undefined,
    };
    const { wrapper, queryClient } = mountPanel([artifact(), second]);
    await flushPromises();
    await button(wrapper, 'Delete').trigger('click');
    expect(wrapper.text()).toContain('authoritative manual tombstone');
    await button(wrapper, 'Delete artifact').trigger('click');
    const boxes = wrapper.findAll('input[type="checkbox"]');
    const firstBox = boxes[0];
    const secondBox = boxes[1];
    if (firstBox === undefined || secondBox === undefined)
      throw new Error('Expected merge selectors.');
    await firstBox.setValue(true);
    await secondBox.setValue(true);
    await button(wrapper, 'Merge selected').trigger('click');
    expect(wrapper.text()).toContain(
      'new manual artifact will preserve their payloads',
    );
    await button(wrapper, 'Merge artifacts').trigger('click');
    await flushPromises();
    expect(mocks.edit).toHaveBeenCalledWith(
      expect.objectContaining({ edit: { operation: 'delete' } }),
    );
    expect(mocks.merge).toHaveBeenCalledWith(
      expect.objectContaining({
        merge: expect.objectContaining({
          sourceArtifactIds: [ARTIFACT_ID, second.id],
        }),
      }),
    );
    queryClient.clear();
    wrapper.unmount();
  });
});
