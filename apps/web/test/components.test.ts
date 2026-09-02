// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/vue';
import { mount } from '@vue/test-utils';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import AppDialog from '../src/components/AppDialog.vue';
import AppStatus from '../src/components/AppStatus.vue';

afterEach(cleanup);

beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute('open');
        this.dispatchEvent(new Event('close'));
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

describe('accessible shell components', () => {
  it('renders status with both text and an accessible description', async () => {
    const { container, getByRole, getByText } = render(AppStatus, {
      props: {
        detail: 'Only offline-ready features are available',
        label: 'Offline',
        tone: 'warning',
      },
    });

    expect(getByText('Offline')).toBeTruthy();
    expect(getByRole('status').getAttribute('aria-label')).toBe(
      'Only offline-ready features are available',
    );
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it('opens, labels, closes, and restores control through a native dialog', async () => {
    const wrapper = mount(AppDialog, {
      attrs: { id: 'confirmation' },
      props: { title: 'Confirm action' },
      slots: {
        actions: '<button type="button">Continue</button>',
        default: 'Review the action before continuing.',
      },
      attachTo: document.body,
    });

    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    wrapper.vm.open();
    const dialog = wrapper.get('dialog');
    expect(dialog.attributes('open')).toBe('');
    expect(dialog.attributes('aria-labelledby')).toBe('confirmation-title');
    expect((await axe.run(wrapper.element)).violations).toEqual([]);

    wrapper.vm.close();
    expect(dialog.attributes('open')).toBeUndefined();
    expect(wrapper.emitted('closed')).toHaveLength(1);
    expect(document.activeElement).toBe(opener);
    opener.remove();
    wrapper.unmount();
  });
});
