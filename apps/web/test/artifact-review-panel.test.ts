// @vitest-environment jsdom

import type { ArtifactResource } from '@journal/contracts';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import axe from 'axe-core';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
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
  addArtifact: mocks.add,
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

function moodEvidence() {
  return [
    {
      id: '019c5b90-0000-7000-8000-000000000040',
      ordinal: 0,
      sourceLabel: 'typed_text:019c5b90-0000-7000-8000-000000000041',
      sourceType: 'typed_text' as const,
      sourceRevisionId: '019c5b90-0000-7000-8000-000000000041',
      normalization: 'NFC_LF_V1' as const,
      offsetUnit: 'utf16_code_unit' as const,
      startUtf16: 2,
      endUtf16: 29,
      quote: 'felt awful and discouraged',
      quoteHash: 'f'.repeat(64),
      resolutionStatus: 'resolved' as const,
    },
    {
      id: '019c5b90-0000-7000-8000-000000000042',
      ordinal: 1,
      sourceLabel: 'corrected_transcript:019c5b90-0000-7000-8000-000000000043',
      sourceType: 'corrected_transcript' as const,
      sourceRevisionId: '019c5b90-0000-7000-8000-000000000043',
      normalization: 'NFC_LF_V1' as const,
      offsetUnit: 'utf16_code_unit' as const,
      startUtf16: 13,
      endUtf16: 35,
      quote: 'felt hopeful and happy',
      quoteHash: '0'.repeat(64),
      resolutionStatus: 'resolved' as const,
      audioRange: { startMs: 800, endMs: 3200 },
    },
  ];
}

function moodProvenance() {
  return {
    resultId: '019c5b90-0000-7000-8000-000000000044',
    runId: '019c5b90-0000-7000-8000-000000000045',
    processorKey: 'mood',
    processorName: 'Mood',
    processorVersionId: '019c5b90-0000-7000-8000-000000000022',
    semanticVersion: '2.0.0',
    instructionHash: '1'.repeat(64),
    promptTemplateHash: '2'.repeat(64),
    provider: { id: 'fixture', displayName: 'Fixture provider' },
    model: { id: 'fixture-mood-model' },
    processingTimeMilliseconds: 18,
  };
}

function moodObservationArtifact(): ArtifactResource {
  const base = foodArtifact();
  return {
    ...base,
    id: '019c5b90-0000-7000-8000-000000000046',
    logicalKey: 'string:morning-discouraged',
    payload: {
      eventKey: 'morning-discouraged',
      artifactType: 'mood_observation',
      characterization: 'awful and discouraged',
      valence: { state: 'known', value: 'negative' },
      certainty: 'known',
      timePeriod: 'morning',
      context: 'before work',
      clinicalFrame: 'journaling_analysis',
      evidenceOrdinals: [0],
    },
    evidence: moodEvidence(),
    provenance: moodProvenance(),
  };
}

function moodAggregateArtifact(
  insufficientInformation = false,
): ArtifactResource {
  const base = foodArtifact();
  return {
    ...base,
    id: '019c5b90-0000-7000-8000-000000000047',
    logicalKey: 'string:daily-mood-aggregate',
    authority: insufficientInformation ? 'generated' : 'manual',
    overridePaths: insufficientInformation ? [] : ['/rating'],
    ...(insufficientInformation
      ? {}
      : {
          generatedCandidate: {
            id: '019c5b90-0000-7000-8000-000000000048',
            versionId: '019c5b90-0000-7000-8000-000000000048',
            payload: { rating: { state: 'known', value: 3 } },
            payloadHash: '3'.repeat(64),
            status: 'reviewable',
            conflictsWithManualVersionId:
              '019c5b90-0000-7000-8000-000000000049',
            createdAt: NOW,
          },
        }),
    payload: insufficientInformation
      ? {
          eventKey: 'daily-mood-aggregate',
          artifactType: 'daily_mood_aggregate',
          informationStatus: 'insufficient_information',
          rating: { state: 'unknown' },
          clinicalFrame: 'journaling_analysis',
          evidenceOrdinals: [],
        }
      : {
          eventKey: 'daily-mood-aggregate',
          artifactType: 'daily_mood_aggregate',
          informationStatus: 'known',
          rating: { state: 'known', value: 4 },
          summary: 'Mood changed across the day.',
          derivation: {
            ruleId: 'contextual-observations-scale-1-5-v1',
            disclosed: true,
          },
          clinicalFrame: 'journaling_analysis',
          evidenceOrdinals: [0, 1],
        },
    evidence: insufficientInformation ? [] : moodEvidence(),
    provenance: moodProvenance(),
  };
}

function sleepProvenance() {
  return {
    resultId: '019c5b90-0000-7000-8000-000000000050',
    runId: '019c5b90-0000-7000-8000-000000000051',
    processorKey: 'sleep',
    processorName: 'Sleep',
    processorVersionId: '019c5b90-0000-7000-8000-000000000023',
    semanticVersion: '2.0.0',
    instructionHash: '4'.repeat(64),
    promptTemplateHash: '5'.repeat(64),
    provider: { id: 'fixture', displayName: 'Fixture provider' },
    model: { id: 'fixture-sleep-model' },
    processingTimeMilliseconds: 14,
  };
}

function sleepBasis(ruleId: string) {
  return {
    ruleId,
    ruleVersion: '1',
    capturedAt: '2026-08-24T05:30:00Z',
    capturedTimezone: 'America/Chicago',
    effectiveJournalDate: '2026-08-23',
    journalTimezone: 'America/Chicago',
    journalDateAssignment: 'user_override',
  };
}

function sleepArtifact(ambiguous = false): ArtifactResource {
  const base = foodArtifact();
  return {
    ...base,
    id: ambiguous
      ? '019c5b90-0000-7000-8000-000000000052'
      : '019c5b90-0000-7000-8000-000000000053',
    logicalKey: ambiguous
      ? 'string:ambiguous-midnight-sleep'
      : 'string:nightly-2026-08-23',
    authority: ambiguous ? 'generated' : 'manual',
    overridePaths: ambiguous ? [] : ['/associatedDate'],
    payload: {
      eventKey: ambiguous ? 'ambiguous-midnight-sleep' : 'nightly-2026-08-23',
      periodType: ambiguous ? 'other_sleep_period' : 'nightly_sleep',
      associatedDate: ambiguous
        ? {
            state: 'uncertain',
            originalPhrase: 'around midnight',
            candidateDates: ['2026-08-23', '2026-08-24'],
            timezone: 'America/Chicago',
            confidence: 0.5,
            manualOverride: false,
            resolutionBasis: sleepBasis('ambiguous-late-night-v1'),
          }
        : {
            state: 'known',
            originalPhrase: 'last night',
            resolvedDate: '2026-08-22',
            timezone: 'America/Chicago',
            confidence: 1,
            manualOverride: true,
            resolutionBasis: sleepBasis('manual-correction-v1'),
          },
      ...(ambiguous
        ? {}
        : {
            reportedQuality: 'badly',
            reportedDuration: 'seven hours',
            reportedStart: 'around 11 p.m.',
            interruptions: 'woke twice',
          }),
      evidenceOrdinals: [0],
    },
    evidence: [
      {
        id: ambiguous
          ? '019c5b90-0000-7000-8000-000000000054'
          : '019c5b90-0000-7000-8000-000000000055',
        ordinal: 0,
        sourceLabel: 'typed_text:019c5b90-0000-7000-8000-000000000056',
        sourceType: 'typed_text',
        sourceRevisionId: '019c5b90-0000-7000-8000-000000000056',
        normalization: 'NFC_LF_V1',
        offsetUnit: 'utf16_code_unit',
        startUtf16: 0,
        endUtf16: ambiguous ? 32 : 25,
        quote: ambiguous
          ? 'I finally slept around midnight.'
          : 'I slept badly last night.',
        quoteHash: '6'.repeat(64),
        resolutionStatus: 'resolved',
      },
    ],
    provenance: sleepProvenance(),
  };
}

function taskProvenance() {
  return {
    resultId: '019c5b90-0000-7000-8000-000000000060',
    runId: '019c5b90-0000-7000-8000-000000000061',
    processorKey: 'tasks-and-intentions',
    processorName: 'Tasks and intentions',
    processorVersionId: '019c5b90-0000-7000-8000-000000000024',
    semanticVersion: '2.0.0',
    instructionHash: '7'.repeat(64),
    promptTemplateHash: '8'.repeat(64),
    provider: { id: 'fixture', displayName: 'Fixture provider' },
    model: { id: 'fixture-task-model' },
    processingTimeMilliseconds: 16,
  };
}

function taskArtifact(
  intentionClass: 'firm' | 'tentative',
  unsupportedDate = false,
): ArtifactResource {
  const base = foodArtifact();
  const firm = intentionClass === 'firm';
  const quote = firm
    ? unsupportedDate
      ? 'I will organize the garage sometime soon.'
      : 'I will submit the permit tomorrow.'
    : 'Maybe I should learn pottery.';
  return {
    ...base,
    id: firm
      ? unsupportedDate
        ? '019c5b90-0000-7000-8000-000000000062'
        : '019c5b90-0000-7000-8000-000000000063'
      : '019c5b90-0000-7000-8000-000000000064',
    logicalKey: firm
      ? unsupportedDate
        ? 'string:organize-garage'
        : 'string:submit-permit'
      : 'string:learn-pottery',
    payload: {
      eventKey: firm
        ? unsupportedDate
          ? 'organize-garage'
          : 'submit-permit'
        : 'learn-pottery',
      description: firm
        ? unsupportedDate
          ? 'organize the garage'
          : 'submit the permit'
        : 'learn pottery',
      intentionClass,
      status: firm ? 'pending' : 'possible',
      rememberKind: firm ? 'task' : 'general_interest',
      externalTaskPolicy: 'observation_only',
      ...(firm
        ? {
            dueDate: {
              state: unsupportedDate ? 'unsupported' : 'known',
              originalPhrase: unsupportedDate ? 'sometime soon' : 'tomorrow',
              ...(unsupportedDate ? {} : { resolvedDate: '2026-08-24' }),
              timezone: 'America/Chicago',
              confidence: unsupportedDate ? 0 : 1,
              manualOverride: false,
              resolutionBasis: {
                ...sleepBasis(
                  unsupportedDate
                    ? 'unsupported-expression-v1'
                    : 'relative-journal-date-v1',
                ),
              },
              evidenceOrdinals: [0],
            },
          }
        : {}),
      evidenceOrdinals: [0],
    },
    evidence: [
      {
        id: firm
          ? unsupportedDate
            ? '019c5b90-0000-7000-8000-000000000065'
            : '019c5b90-0000-7000-8000-000000000066'
          : '019c5b90-0000-7000-8000-000000000067',
        ordinal: 0,
        sourceLabel: 'typed_text:019c5b90-0000-7000-8000-000000000068',
        sourceType: 'typed_text',
        sourceRevisionId: '019c5b90-0000-7000-8000-000000000068',
        normalization: 'NFC_LF_V1',
        offsetUnit: 'utf16_code_unit',
        startUtf16: 0,
        endUtf16: quote.length,
        quote,
        quoteHash: '9'.repeat(64),
        resolutionStatus: 'resolved',
      },
    ],
    provenance: taskProvenance(),
  };
}

function mountPanel(items: readonly ArtifactResource[] = [artifact()]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  mocks.list.mockResolvedValue(items);
  mocks.add.mockResolvedValue(items);
  mocks.edit.mockResolvedValue(items);
  mocks.merge.mockResolvedValue(items);
  const wrapper = mount(ArtifactReviewPanel, {
    props: { journalDayId: DAY_ID },
    attachTo: document.body,
    global: { plugins: [[VueQueryPlugin, { queryClient }]] },
  });
  return { wrapper, queryClient };
}

function summaryArtifact(): ArtifactResource {
  const base = foodArtifact();
  const provenance = base.provenance;
  if (provenance === undefined) throw new Error('Expected provenance fixture.');
  return {
    ...base,
    id: '019c5b90-0000-7000-8000-000000000070',
    processorId: '019c5b90-0000-7000-8000-000000000005',
    logicalKey: 'string:daily-narrative',
    kind: 'interpretation',
    payload: {
      summaryKey: 'daily-narrative',
      artifactType: 'narrative_summary',
      narrative: 'The day included finishing the garden gate and a picnic.',
      tonePolicy: 'source_only',
      unknownValuePolicy: 'exclude_or_report',
      evidenceOrdinals: [0],
    },
    provenance: {
      ...provenance,
      processorKey: 'summary',
      processorName: 'Summary',
    },
  };
}

function accomplishmentArtifact(): ArtifactResource {
  const base = foodArtifact();
  const provenance = base.provenance;
  if (provenance === undefined) throw new Error('Expected provenance fixture.');
  return {
    ...base,
    id: '019c5b90-0000-7000-8000-000000000071',
    processorId: '019c5b90-0000-7000-8000-000000000006',
    logicalKey: 'string:finished-garden-gate',
    kind: 'interpretation',
    payload: {
      bulletKey: 'finished-garden-gate',
      artifactType: 'accomplishment',
      text: 'Finished the garden gate',
      completionBasis: 'source_explicit',
      significanceBasis: 'source_explicit',
      pinned: false,
      evidenceOrdinals: [0],
    },
    provenance: {
      ...provenance,
      processorKey: 'accomplishments',
      processorName: 'Accomplishments',
    },
  };
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

  it('[SUM-001–004][SEM-004][AC-032] renders separate grounded narrative and accomplishment cards and preserves pin as a manual action', async () => {
    const { wrapper, queryClient } = mountPanel([
      summaryArtifact(),
      accomplishmentArtifact(),
    ]);
    await flushPromises();
    expect(wrapper.text()).toContain('Daily narrative summary');
    expect(wrapper.text()).toContain(
      'The day included finishing the garden gate and a picnic.',
    );
    expect(wrapper.text()).toContain('Finished the garden gate');
    expect(wrapper.text()).toContain('Accomplishment');
    expect(wrapper.text()).toContain(
      'Unknown values are excluded or reported separately',
    );
    await button(wrapper, 'Pin').trigger('click');
    await flushPromises();
    expect(mocks.edit).toHaveBeenCalledWith(
      expect.objectContaining({ edit: { operation: 'pin', pinned: true } }),
    );
    expect((await axe.run(wrapper.element)).violations).toEqual([]);
    queryClient.clear();
    wrapper.unmount();
  });

  it('[SUM-004] adds an authoritative pinned bullet without claiming generated evidence', async () => {
    const { wrapper, queryClient } = mountPanel([]);
    await flushPromises();
    await button(wrapper, 'Add notable bullet').trigger('click');
    await wrapper
      .get('#artifact-bullet-add textarea')
      .setValue('Helped a neighbor');
    await button(wrapper, 'Add bullet').trigger('click');
    await flushPromises();
    expect(mocks.add).toHaveBeenCalledWith(
      expect.objectContaining({
        journalDayId: DAY_ID,
        artifact: expect.objectContaining({
          processorKey: 'accomplishments',
          kind: 'interpretation',
          payload: expect.objectContaining({
            text: 'Helped a neighbor',
            pinned: true,
            evidenceOrdinals: [],
          }),
        }),
      }),
    );
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

  it('[AC-023][MOOD-001–003][MOOD-005][MOOD-006][PROV-001] presents contextual observations and a separate manual aggregate with exact evidence and non-clinical framing', async () => {
    const { wrapper, queryClient } = mountPanel([
      moodObservationArtifact(),
      moodAggregateArtifact(),
    ]);
    await flushPromises();
    expect(wrapper.text()).toContain('awful and discouraged');
    expect(wrapper.text()).toContain('Mood observation');
    expect(wrapper.text()).toContain('Time period');
    expect(wrapper.text()).toContain('morning');
    expect(wrapper.text()).toContain('Context');
    expect(wrapper.text()).toContain('before work');
    expect(wrapper.text()).toContain('Daily mood aggregate');
    expect(wrapper.text()).toContain('Interpretation');
    expect(wrapper.text()).toContain('Overall rating');
    expect(wrapper.text()).toContain('4 / 5');
    expect(wrapper.text()).toContain('Mood changed across the day.');
    expect(wrapper.text()).toContain('Disclosed derivation rule:');
    expect(wrapper.text()).toContain('contextual-observations-scale-1-5-v1');
    expect(wrapper.text()).toContain(
      'Journaling analysis, not a clinical assessment.',
    );
    expect(wrapper.text()).toContain('Manual authority');
    expect(wrapper.text()).toContain('Your manual value is still active.');
    expect(wrapper.text()).toContain('felt awful and discouraged');
    expect(wrapper.text()).toContain('felt hopeful and happy');
    expect(wrapper.text()).toContain('Audio 800–3200 ms');
    expect((await axe.run(wrapper.element)).violations).toEqual([]);
    queryClient.clear();
    wrapper.unmount();
  });

  it('[AC-022][MOOD-004][SEM-002][SEM-004] labels absent mood as unknown insufficient information rather than neutral', async () => {
    const { wrapper, queryClient } = mountPanel([moodAggregateArtifact(true)]);
    await flushPromises();
    expect(wrapper.text()).toContain('Insufficient information');
    expect(wrapper.text()).toContain(
      'This is unknown, not neutral, and is excluded from numerical averages.',
    );
    expect(wrapper.text()).not.toContain('Explicitly neutral');
    expect((await axe.run(wrapper.element)).violations).toEqual([]);
    queryClient.clear();
    wrapper.unmount();
  });

  it('[SLEEP-001–003][TIME-005–007][PROV-001][AC-040] discloses wake-date semantics, manual correction, uncertainty, temporal provenance, and evidence accessibly', async () => {
    const { wrapper, queryClient } = mountPanel([
      sleepArtifact(),
      sleepArtifact(true),
    ]);
    await flushPromises();
    expect(wrapper.text()).toContain('Nightly sleep');
    expect(wrapper.text()).toContain('Sleep observation');
    expect(wrapper.text()).toContain('Date corrected manually');
    expect(wrapper.text()).toContain('Associated wake date');
    expect(wrapper.text()).toContain('2026-08-22');
    expect(wrapper.text()).toContain('Original temporal phrase');
    expect(wrapper.text()).toContain('last night');
    expect(wrapper.text()).toContain(
      'Nightly sleep is associated with the date you woke by default.',
    );
    expect(wrapper.text()).toContain('Reported quality');
    expect(wrapper.text()).toContain('seven hours');
    expect(wrapper.text()).toContain('woke twice');
    expect(wrapper.text()).toContain('Ambiguous sleep date');
    expect(wrapper.text()).toContain('Candidate dates: 2026-08-23, 2026-08-24');
    expect(wrapper.text()).toContain('Temporal resolution details');
    expect(wrapper.text()).toContain('manual-correction-v1');
    expect(wrapper.text()).toContain('America/Chicago');
    expect(wrapper.text()).toContain('I slept badly last night.');
    expect(wrapper.text()).toContain('Sleep version 2.0.0');
    expect((await axe.run(wrapper.element)).violations).toEqual([]);
    queryClient.clear();
    wrapper.unmount();
  });

  it('[AC-024][TASK-001–005][TIME-004][PROV-001] distinguishes tentative and firm task cards while disclosing supported, absent, and unsupported dates accessibly', async () => {
    const { wrapper, queryClient } = mountPanel([
      taskArtifact('tentative'),
      taskArtifact('firm'),
      taskArtifact('firm', true),
    ]);
    await flushPromises();
    expect(wrapper.text()).toContain('learn pottery');
    expect(wrapper.text()).toContain('Tentative idea');
    expect(wrapper.text()).toContain('possible');
    expect(wrapper.text()).toContain(
      'No due date was supported by the source.',
    );
    expect(wrapper.text()).toContain('submit the permit');
    expect(wrapper.text()).toContain('Firm intention');
    expect(wrapper.text()).toContain('pending');
    expect(wrapper.text()).toContain('Supported due date');
    expect(wrapper.text()).toContain('2026-08-24');
    expect(wrapper.text()).toContain('Original temporal phrase');
    expect(wrapper.text()).toContain('tomorrow');
    expect(wrapper.text()).toContain('No supported due date');
    expect(wrapper.text()).toContain('sometime soon');
    expect(wrapper.text()).toContain('Due-date resolution details');
    expect(wrapper.text()).toContain('relative-journal-date-v1');
    expect(wrapper.text()).toContain('Effective Journal Day');
    expect(wrapper.text()).toContain(
      'Journal observation only. No external task was created;',
    );
    expect(wrapper.text()).toContain('I will submit the permit tomorrow.');
    expect(wrapper.text()).toContain('Tasks and intentions version 2.0.0');
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
