// @vitest-environment jsdom

import type { NudgeDayResource, NudgePreference } from '@journal/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  actOnNudge,
  getNudgeDay,
  getNudgePreferences,
  NudgeApiError,
  updateNudgePreferences,
} from '../src/nudge/api';

const DIGEST_ID = '019c5b90-0000-7000-8000-000000000060';
const ITEM_ID = '019c5b90-0000-7000-8000-000000000061';
const CONTRIBUTION_ID = '019c5b90-0000-7000-8000-000000000062';
const REVISION_ID = '019c5b90-0000-7000-8000-000000000063';
const CORRELATION_ID = '019c5b90-0000-7000-8000-000000000064';
const NOW = '2026-08-24T17:00:00.000Z';

const day: NudgeDayResource = {
  journalDate: '2026-08-24',
  evaluations: [],
};

const preference: NudgePreference = {
  quietStartHour: 21,
  quietEndHour: 8,
  dailyLimit: 2,
  revision: 4,
  ownerTimezone: 'America/Chicago',
  updatedAt: NOW,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('nudge API client', () => {
  it('[NUDGE-002][SEC-001] requests and validates the selected owner day without mutation headers', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(day));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getNudgeDay('2026-08-24')).resolves.toEqual(day);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/nudges?journalDate=2026-08-24',
      { credentials: 'same-origin', headers: {} },
    );
  });

  it('[NUDGE-006][STATE-004] validates an answer and sends CSRF, idempotency, and the exact digest precondition', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        day,
        responseContributionId: CONTRIBUTION_ID,
        idempotency: { key: 'answer-request-1', replayed: false },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const action = {
      action: 'answer' as const,
      itemId: ITEM_ID,
      text: 'I slept well.',
      contributionId: CONTRIBUTION_ID,
      revisionId: REVISION_ID,
      capturedAt: NOW,
      capturedTimezone: 'Etc/UTC',
    };

    await expect(
      actOnNudge({
        digestId: DIGEST_ID,
        digestRevision: 3,
        action,
        csrfToken: 'csrf-token',
        idempotencyKey: 'answer-request-1',
      }),
    ).resolves.toEqual(day);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/nudges/${DIGEST_ID}/actions`,
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'answer-request-1',
          'if-match': '"nudge-3"',
          'x-csrf-token': 'csrf-token',
        },
      }),
    );
    const [fetchCall] = fetchMock.mock.calls;
    if (fetchCall === undefined) throw new Error('Expected a request.');
    const [, init] = fetchCall;
    expect(JSON.parse(String(init?.body))).toEqual(action);
  });

  it('[NUDGE-005][TIME-001][STATE-004] reads preferences and updates them with their exact revision', async () => {
    const updated = { ...preference, quietStartHour: 22, revision: 5 };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(preference))
      .mockResolvedValueOnce(
        jsonResponse({
          preference: updated,
          idempotency: { key: 'preference-request-1', replayed: false },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getNudgePreferences()).resolves.toEqual(preference);
    await expect(
      updateNudgePreferences({
        preference,
        changes: { quietStartHour: 22, quietEndHour: 8, dailyLimit: 2 },
        csrfToken: 'csrf-token',
        idempotencyKey: 'preference-request-1',
      }),
    ).resolves.toEqual(updated);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/nudges/preferences', {
      credentials: 'same-origin',
      headers: {},
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/nudges/preferences', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'preference-request-1',
        'if-match': '"nudge-preferences-4"',
        'x-csrf-token': 'csrf-token',
      },
      body: JSON.stringify({
        quietStartHour: 22,
        quietEndHour: 8,
        dailyLimit: 2,
      }),
    });
  });

  it('[STATE-003][SEC-003] maps stable problem details and does not reflect an untrusted non-JSON body', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            type: 'about:blank',
            title: 'Digest changed',
            detail: 'Reload this digest before answering.',
            status: 412,
            code: 'nudge_precondition_failed',
            correlationId: CORRELATION_ID,
          },
          412,
        ),
      )
      .mockResolvedValueOnce(
        new Response('<h1>private upstream response</h1>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getNudgePreferences()).rejects.toMatchObject<
      Partial<NudgeApiError>
    >({
      status: 412,
      code: 'nudge_precondition_failed',
      message: 'Reload this digest before answering.',
    });
    await expect(getNudgePreferences()).rejects.toMatchObject<
      Partial<NudgeApiError>
    >({
      status: 502,
      code: 'unknown',
      message: 'The required-information request failed.',
    });
  });

  it('[NUDGE-005] rejects an invalid quiet-hours window before sending it', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      updateNudgePreferences({
        preference,
        changes: { quietStartHour: 8, quietEndHour: 8, dailyLimit: 2 },
        csrfToken: 'csrf-token',
        idempotencyKey: 'preference-request-2',
      }),
    ).rejects.toThrow('Quiet hours must leave a delivery window.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
