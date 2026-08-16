// @vitest-environment jsdom

import { contributionSchema } from '@journal/contracts';
import { mount } from '@vue/test-utils';
import axe from 'axe-core';
import { beforeEach, describe, expect, it } from 'vitest';

import ContributionCard from '../src/components/ContributionCard.vue';
import { displayJournalDate, shiftJournalDate } from '../src/journal/date';

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
});
