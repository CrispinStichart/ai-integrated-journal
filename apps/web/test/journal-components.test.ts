// @vitest-environment jsdom

import { contributionSchema } from '@journal/contracts';
import { mount } from '@vue/test-utils';
import axe from 'axe-core';
import { beforeEach, describe, expect, it } from 'vitest';

import ContributionCard from '../src/components/ContributionCard.vue';
import AudioContributionCard from '../src/components/AudioContributionCard.vue';
import { displayJournalDate, shiftJournalDate } from '../src/journal/date';
import type { LocalRecordingRecord } from '../src/storage/indexed-db';

const contribution = contributionSchema.parse({
  id: '018f0000-0000-7000-8000-000000000003',
  journalDayId: '018f0000-0000-7000-8000-000000000002',
  journalDate: '2026-08-16',
  authorId: '018f0000-0000-7000-8000-000000000001',
  sourceType: 'typed_text',
  capturedAt: '2026-08-16T12:00:00.000Z',
  capturedTimezone: 'UTC',
  journalTimezone: 'UTC',
  journalDateAssignment: 'default',
  currentRevision: {
    id: '018f0000-0000-7000-8000-000000000004',
    contributionId: '018f0000-0000-7000-8000-000000000003',
    revision: 1,
    text: 'A source-preserving note',
    authority: 'manual',
    authorId: '018f0000-0000-7000-8000-000000000001',
    createdAt: '2026-08-16T12:00:00.000Z',
  },
});

const audioContribution = contributionSchema.parse({
  id: '018f0000-0000-7000-8000-000000000013',
  journalDayId: '018f0000-0000-7000-8000-000000000002',
  journalDate: '2026-08-16',
  authorId: '018f0000-0000-7000-8000-000000000001',
  sourceType: 'recording',
  capturedAt: '2026-08-16T00:30:00.000Z',
  capturedTimezone: 'UTC',
  journalTimezone: 'UTC',
  journalDateAssignment: 'user_override',
  recording: {
    id: '018f0000-0000-7000-8000-000000000014',
    mimeType: 'audio/webm;codecs=opus',
    codec: 'opus',
    persistenceState: 'durable',
    byteSize: '1024',
  },
});

const failedLocalAudio: LocalRecordingRecord = {
  recordingId: '018f0000-0000-7000-8000-000000000014',
  contributionId: audioContribution.id,
  uploadId: '018f0000-0000-7000-8000-000000000015',
  proposedJournalDayId: audioContribution.journalDayId,
  ownerId: audioContribution.authorId,
  schemaVersion: 1,
  mimeType: 'audio/webm;codecs=opus',
  codec: 'opus',
  capturedAt: audioContribution.capturedAt,
  capturedTimezone: audioContribution.capturedTimezone,
  journalTimezone: audioContribution.journalTimezone,
  journalDate: audioContribution.journalDate,
  journalDateAssignment: 'user_override',
  state: 'failed',
  nextChunkIndex: 2,
  totalBytes: '1024',
  retrySafe: true,
  syncErrorCode: 'network_unavailable',
  syncErrorMessage: 'Audio is still saved locally. Reconnect and retry.',
  createdAt: audioContribution.capturedAt,
  updatedAt: audioContribution.capturedAt,
};

beforeEach(() => {
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
});

describe('Journal Day contribution UI (DATA-003, DATA-010–DATA-012, DATA-026, RET-005–RET-006)', () => {
  it('retains visible source provenance and emits a new revision without changing the source', async () => {
    const wrapper = mount(ContributionCard, {
      props: { contribution, revisions: undefined, busy: false },
      attachTo: document.body,
    });

    expect(wrapper.text()).toContain('Typed note');
    expect(wrapper.text()).toContain('Manual source');
    expect(wrapper.text()).toContain('UTC');
    await wrapper.get('button:nth-of-type(2)').trigger('click');
    const textarea = wrapper.get('textarea');
    await textarea.setValue('A corrected source note');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('edit')?.[0]).toEqual([
      contribution,
      'A corrected source note',
      '',
    ]);
    expect((await axe.run(wrapper.element)).violations).toEqual([]);
    wrapper.unmount();
  });

  it('shows revision history, warns before deletion, and offers restoration for deleted content', async () => {
    const revision = contribution.currentRevision;
    if (revision === undefined) throw new Error('Expected a fixture revision');
    const wrapper = mount(ContributionCard, {
      props: { contribution, revisions: [revision], busy: false },
      attachTo: document.body,
    });
    await wrapper.get('button').trigger('click');
    expect(wrapper.find(`#history-${contribution.id}`).attributes('open')).toBe(
      '',
    );
    expect(wrapper.text()).toContain('Every saved version remains available');

    const deleteButton = wrapper
      .findAll('button')
      .find((button) => button.text() === 'Delete');
    await deleteButton?.trigger('click');
    expect(wrapper.text()).toContain(
      'recoverable during the deletion grace period',
    );
    wrapper.unmount();

    const deletedWrapper = mount(ContributionCard, {
      props: {
        contribution: {
          ...contribution,
          deletedAt: '2026-08-16T13:00:00.000Z',
        },
        revisions: [revision],
        busy: false,
      },
    });
    await deletedWrapper.get('button:nth-of-type(2)').trigger('click');
    expect(deletedWrapper.emitted('restore')).toBeTruthy();
  });

  it('navigates calendar dates without timezone reassignment', () => {
    expect(shiftJournalDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftJournalDate('2024-02-28', 1)).toBe('2024-02-29');
    expect(displayJournalDate('2026-08-16')).toContain('2026');
  });

  it('[CAP-006] exposes durable, processing, range-playback, failure, and safe retry UI', async () => {
    const durable = mount(AudioContributionCard, {
      props: { contribution: audioContribution },
      attachTo: document.body,
    });
    expect(durable.text()).toContain('Durably saved');
    expect(durable.text()).toContain('Transcription pending');
    expect(durable.get('audio').attributes()).toMatchObject({
      controls: '',
      preload: 'metadata',
      src: `/api/v1/recordings/${audioContribution.recording?.id}/audio`,
    });
    expect((await axe.run(durable.element)).violations).toEqual([]);
    durable.unmount();

    const failed = mount(AudioContributionCard, {
      props: { contribution: audioContribution, local: failedLocalAudio },
    });
    expect(failed.text()).toContain('Failed');
    expect(failed.text()).toContain('Retry safely');
    await failed.get('button').trigger('click');
    expect(failed.emitted('retry')).toHaveLength(1);

    const durableRecording = audioContribution.recording;
    if (durableRecording === undefined)
      throw new Error('Expected recording fixture.');
    const transcriptionFailed = mount(AudioContributionCard, {
      props: {
        contribution: {
          ...audioContribution,
          recording: {
            ...durableRecording,
            transcription: {
              state: 'failed',
              runId: '018f0000-0000-7000-8000-000000000016',
            },
          },
        },
      },
      attachTo: document.body,
    });
    expect(transcriptionFailed.text()).toContain('Transcription failed');
    expect(transcriptionFailed.text()).toContain(
      'original audio remains safely stored',
    );
    await transcriptionFailed.get('button').trigger('click');
    expect(transcriptionFailed.emitted('retryTranscription')).toHaveLength(1);
    expect((await axe.run(transcriptionFailed.element)).violations).toEqual([]);
    transcriptionFailed.unmount();
  });

  it('[CAP-007][AC-040] offers reassignment while retaining capture provenance', async () => {
    const wrapper = mount(AudioContributionCard, {
      props: { contribution: audioContribution },
    });
    expect(wrapper.text()).toContain('Captured');
    expect(wrapper.text()).toContain('UTC');
    await wrapper.get('input[type="date"]').setValue('2026-08-15');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('move')?.[0]).toEqual(['2026-08-15']);
  });
});
