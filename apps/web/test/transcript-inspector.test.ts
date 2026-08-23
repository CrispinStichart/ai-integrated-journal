// @vitest-environment jsdom

import type { RecordingTranscriptInspector } from '@journal/contracts';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import axe from 'axe-core';
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  edit: vi.fn(),
  get: vi.fn(),
  history: vi.fn(),
  retryCleanup: vi.fn(),
}));

vi.mock('../src/auth', () => ({
  useAuthentication: () => ({ status: ref({ csrfToken: 'csrf-token' }) }),
}));

vi.mock('../src/journal/api', () => ({
  createUuidV7: () => '019c5b90-0000-7000-8000-000000000099',
}));

vi.mock('../src/transcript/api', () => ({
  editCorrectedTranscript: mocks.edit,
  getRecordingTranscripts: mocks.get,
  listTranscriptRevisions: mocks.history,
  retryTranscriptCleanup: mocks.retryCleanup,
}));

import TranscriptInspector from '../src/components/TranscriptInspector.vue';
import AudioContributionCard from '../src/components/AudioContributionCard.vue';

const RECORDING_ID = '019c5b90-0000-7000-8000-000000000021';
const RAW_ID = '019c5b90-0000-7000-8000-000000000022';
const RAW_REVISION_ID = '019c5b90-0000-7000-8000-000000000023';
const CORRECTED_ID = '019c5b90-0000-7000-8000-000000000024';
const CORRECTED_REVISION_ID = '019c5b90-0000-7000-8000-000000000025';
const CLEANED_ID = '019c5b90-0000-7000-8000-000000000026';
const CLEANED_REVISION_ID = '019c5b90-0000-7000-8000-000000000027';
const RUN_ID = '019c5b90-0000-7000-8000-000000000028';
const SEGMENT_ID = '019c5b90-0000-7000-8000-000000000029';
const NOW = '2026-08-23T12:00:00.000Z';

function inspector(timed = true): RecordingTranscriptInspector {
  const rawRevision = {
    id: RAW_REVISION_ID,
    transcriptId: RAW_ID,
    revision: 1,
    text: 'Raw provider words',
    authority: 'generated' as const,
    sourceRunId: RUN_ID,
    language: { code: 'en' },
    timingAvailability: { segments: timed ? 'known' : 'unknown' },
    segments: [
      {
        id: SEGMENT_ID,
        ordinal: 0,
        startUtf16: 0,
        endUtf16: 18,
        quote: 'Raw provider words',
        timing: timed
          ? {
              status: 'known' as const,
              startMilliseconds: '1200',
              endMilliseconds: '2600',
            }
          : { status: 'unknown' as const },
      },
    ],
    createdAt: NOW,
  };
  return {
    recordingId: RECORDING_ID,
    audioAvailable: true,
    transcription: {
      id: RUN_ID,
      stage: 'transcription',
      status: 'succeeded',
      attempt: 1,
      retryable: false,
      queuedAt: NOW,
      completedAt: NOW,
    },
    cleanup: {
      id: SEGMENT_ID,
      stage: 'cleanup',
      status: 'succeeded',
      attempt: 1,
      retryable: false,
      sourceRevisionId: CORRECTED_REVISION_ID,
      queuedAt: NOW,
      completedAt: NOW,
    },
    rawStt: {
      id: RAW_ID,
      recordingId: RECORDING_ID,
      layer: 'raw_stt',
      revisionCount: 1,
      currentRevision: rawRevision,
      createdAt: NOW,
      updatedAt: NOW,
    },
    corrected: {
      id: CORRECTED_ID,
      recordingId: RECORDING_ID,
      layer: 'corrected',
      revisionCount: 1,
      currentRevision: {
        ...rawRevision,
        id: CORRECTED_REVISION_ID,
        transcriptId: CORRECTED_ID,
        sourceRevisionId: RAW_REVISION_ID,
      },
      createdAt: NOW,
      updatedAt: NOW,
    },
    cleaned: {
      id: CLEANED_ID,
      recordingId: RECORDING_ID,
      layer: 'cleaned',
      revisionCount: 1,
      currentRevision: {
        ...rawRevision,
        id: CLEANED_REVISION_ID,
        transcriptId: CLEANED_ID,
        text: 'Clean words',
        sourceRevisionId: CORRECTED_REVISION_ID,
        segments: [],
      },
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

function mountInspector(value: RecordingTranscriptInspector) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  mocks.get.mockResolvedValue(value);
  mocks.history.mockResolvedValue([value.rawStt?.currentRevision]);
  const wrapper = mount(TranscriptInspector, {
    props: { recordingId: RECORDING_ID },
    attachTo: document.body,
    global: { plugins: [[VueQueryPlugin, { queryClient }]] },
  });
  return { wrapper, queryClient };
}

function buttonByText(wrapper: ReturnType<typeof mount>, text: string) {
  const button = wrapper
    .findAll('button')
    .find((item) => item.text().includes(text));
  if (button === undefined) throw new Error(`Button not found: ${text}`);
  return button;
}

describe('Transcript inspector UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('[AC-010][DATA-022][DATA-024][DATA-025] labels immutable raw, corrected, and cleaned artifacts distinctly', async () => {
    const { wrapper, queryClient } = mountInspector(inspector());
    await flushPromises();

    expect(wrapper.text()).toContain('Raw STT');
    expect(wrapper.text()).toContain('Corrected');
    expect(wrapper.text()).toContain('Cleaned');
    expect(wrapper.text()).toContain('Immutable provider capture');
    expect(wrapper.text()).toContain('Raw provider words');
    expect((await axe.run(wrapper.element)).violations).toEqual([]);

    queryClient.clear();
    wrapper.unmount();
  });

  it('[AC-011][EDIT-001][MEM-002] edits only corrected text and exposes dependent staleness', async () => {
    const original = inspector();
    const updated = inspector();
    if (updated.corrected === undefined || updated.cleaned === undefined)
      throw new Error('Expected transcript layers.');
    updated.corrected = {
      ...updated.corrected,
      revisionCount: 2,
      currentRevision: {
        ...updated.corrected.currentRevision,
        id: '019c5b90-0000-7000-8000-000000000030',
        revision: 2,
        text: 'Human corrected words',
        authority: 'manual',
      },
    };
    updated.cleaned = {
      ...updated.cleaned,
      currentRevision: {
        ...updated.cleaned.currentRevision,
        staleAt: NOW,
        staleReason: 'source_revision_superseded',
      },
    };
    updated.cleanup = {
      id: '019c5b90-0000-7000-8000-000000000031',
      stage: 'cleanup',
      status: 'queued',
      attempt: 1,
      retryable: false,
      sourceRevisionId: updated.corrected.currentRevision.id,
      queuedAt: NOW,
    };
    mocks.edit.mockResolvedValue(updated);
    const { wrapper, queryClient } = mountInspector(original);
    await flushPromises();

    await buttonByText(wrapper, 'Corrected').trigger('click');
    await buttonByText(wrapper, 'Edit corrected transcript').trigger('click');
    expect(wrapper.text()).toContain('does not create a global rule');
    await wrapper.get('textarea').setValue('Human corrected words');
    await wrapper
      .get('form[aria-label="Edit corrected transcript"]')
      .trigger('submit');
    await flushPromises();

    expect(mocks.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptId: CORRECTED_ID,
        revision: 1,
        text: 'Human corrected words',
      }),
    );
    expect(wrapper.text()).toContain('Raw STT is unchanged');
    expect(wrapper.text()).toContain('replacement cleanup is queued');
    await buttonByText(wrapper, 'Raw STT').trigger('click');
    expect(wrapper.text()).toContain('Raw provider words');
    await buttonByText(wrapper, 'Cleaned').trigger('click');
    expect(wrapper.text()).toContain('derived revision is stale');

    queryClient.clear();
    wrapper.unmount();
  });

  it('[AC-012][DATA-027] seeks timed evidence to the exact audio start', async () => {
    const { wrapper, queryClient } = mountInspector(inspector());
    await flushPromises();

    await wrapper.get('button[aria-label^="Play evidence"]').trigger('click');
    expect(wrapper.emitted('seek')).toEqual([[1200]]);

    queryClient.clear();
    wrapper.unmount();
  });

  it('[AC-010][AC-012] keeps original audio beside distinct layers and navigates playback from evidence', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mocks.get.mockResolvedValue(inspector());
    const wrapper = mount(AudioContributionCard, {
      props: {
        contribution: {
          id: '019c5b90-0000-7000-8000-000000000040',
          journalDayId: '019c5b90-0000-7000-8000-000000000041',
          journalDate: '2026-08-23',
          authorId: '019c5b90-0000-7000-8000-000000000042',
          sourceType: 'recording',
          capturedAt: NOW,
          capturedTimezone: 'UTC',
          journalTimezone: 'UTC',
          journalDateAssignment: 'default',
          recording: {
            id: RECORDING_ID,
            mimeType: 'audio/webm;codecs=opus',
            persistenceState: 'durable',
            transcription: { state: 'succeeded', runId: RUN_ID },
          },
        },
      },
      attachTo: document.body,
      global: { plugins: [[VueQueryPlugin, { queryClient }]] },
    });
    await flushPromises();
    const player = wrapper.get('audio').element;
    player.play = vi.fn(async () => undefined);

    await wrapper.get('button[aria-label^="Play evidence"]').trigger('click');

    expect(player.currentTime).toBe(1.2);
    expect(player.play).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain('Audio recording');
    expect(wrapper.text()).toContain('Raw STT');
    expect(wrapper.text()).toContain('Corrected');
    expect(wrapper.text()).toContain('Cleaned');

    queryClient.clear();
    wrapper.unmount();
  });

  it('[AC-012][DATA-028] clearly treats missing timing as unavailable, not failed', async () => {
    const { wrapper, queryClient } = mountInspector(inspector(false));
    await flushPromises();

    expect(wrapper.text()).toContain('Timing unavailable');
    expect(wrapper.text()).toContain('This transcript is valid');
    expect(wrapper.text()).not.toContain('Transcription failed');
    expect((await axe.run(wrapper.element)).violations).toEqual([]);

    queryClient.clear();
    wrapper.unmount();
  });
});
