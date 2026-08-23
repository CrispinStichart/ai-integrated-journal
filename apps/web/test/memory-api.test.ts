// @vitest-environment jsdom

import type { MemoryResource } from '@journal/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFeedback, listMemories, mutateMemory } from '../src/memory/api';

const MEMORY_ID = '019c5b90-0000-7000-8000-000000000021';
const REVISION_ID = '019c5b90-0000-7000-8000-000000000022';
const TARGET_ID = '019c5b90-0000-7000-8000-000000000023';
const FEEDBACK_ID = '019c5b90-0000-7000-8000-000000000024';
const NOW = '2026-08-23T12:00:00.000Z';
const memory: MemoryResource = {
  id: MEMORY_ID,
  revision: 3,
  currentRevision: {
    id: REVISION_ID,
    revision: 3,
    type: 'correction_rule',
    content: 'Spell the name Nicolette.',
    rationale: 'An explicit correction from the journal owner.',
    creator: 'user',
    approvalState: 'approved',
    scope: { kind: 'global_transcription' },
    enabled: true,
    createdAt: NOW,
  },
  history: [],
  historyTruncated: false,
  createdAt: NOW,
  updatedAt: NOW,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('memory and feedback API client', () => {
  it('[MEM-004] lists visible memories with bounded defaults and no mutation content type', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ items: [memory], page: { hasMore: false } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(listMemories()).resolves.toEqual([memory]);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/memories?limit=50', {
      credentials: 'same-origin',
      headers: {},
    });
  });

  it('[MEM-004] sends explicit search and lifecycle visibility filters', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ items: [], page: { hasMore: false } }));
    vi.stubGlobal('fetch', fetchMock);

    await listMemories({
      q: 'preferred name',
      includeDisabled: true,
      includeDeleted: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/memories?limit=50&q=preferred+name&includeDisabled=true&includeDeleted=true',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });

  it('[MEM-004][MEM-005][STATE-004] validates mutations and sends the exact memory revision precondition', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        memory,
        idempotency: { key: 'disable-memory', replayed: false },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      mutateMemory({
        memoryId: MEMORY_ID,
        revision: 3,
        mutation: { operation: 'disable' },
        csrfToken: 'csrf-token',
        idempotencyKey: 'disable-memory',
      }),
    ).resolves.toEqual(memory);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/memories/${MEMORY_ID}/mutations`,
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': 'csrf-token',
          'idempotency-key': 'disable-memory',
          'if-match': '"memory-3"',
        },
        body: JSON.stringify({ operation: 'disable' }),
      }),
    );
  });

  it('[MEM-001][FB-002][FB-003] sends an explicitly approved persistent correction and returns its visible memory', async () => {
    const feedback = {
      id: FEEDBACK_ID,
      target: { kind: 'transcript_revision' as const, id: TARGET_ID },
      message: 'Remember this spelling.',
      classifiedScope: { kind: 'global_transcription' as const },
      memoryId: MEMORY_ID,
      createdAt: NOW,
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        feedback,
        memory,
        idempotency: { key: 'remember-name', replayed: false },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createFeedback({
        feedback: {
          mode: 'correct_and_remember',
          target: { kind: 'transcript_revision', id: TARGET_ID },
          message: 'Remember this spelling.',
          memory: {
            type: 'correction_rule',
            content: 'Spell the name Nicolette.',
            rationale: 'An explicit correction from the journal owner.',
            scope: { kind: 'global_transcription' },
          },
          approval: 'approved',
        },
        csrfToken: 'csrf-token',
        idempotencyKey: 'remember-name',
      }),
    ).resolves.toEqual({
      feedback,
      memory,
      idempotency: { key: 'remember-name', replayed: false },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/feedback',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'x-csrf-token': 'csrf-token',
          'idempotency-key': 'remember-name',
        }),
      }),
    );
  });

  it('[STATE-003] reports server problem details and preserves the title fallback', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            type: 'about:blank',
            title: 'Memory changed',
            detail: 'Reload the memory before editing it.',
            status: 412,
            code: 'memory_precondition_failed',
            correlationId: TARGET_ID,
          },
          412,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            type: 'about:blank',
            title: 'Memory unavailable',
            status: 503,
            code: 'memory_unavailable',
            correlationId: TARGET_ID,
          },
          503,
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(listMemories()).rejects.toThrow(
      'Reload the memory before editing it.',
    );
    await expect(listMemories()).rejects.toThrow('Memory unavailable');
  });

  it('[STATE-003][SEC-003] fails safely when an upstream error body is not JSON problem details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response('<h1>proxy failure containing private journal data</h1>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );

    await expect(listMemories()).rejects.toThrow('The memory request failed.');
  });

  it('[MEM-001][FB-004] rejects an invalid broad-memory request before sending it', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createFeedback({
        feedback: {
          mode: 'correct_and_remember',
          target: { kind: 'transcript_revision', id: TARGET_ID },
          message: 'Remember this spelling.',
          memory: {
            type: 'correction_rule',
            content: 'Spell the name Nicolette.',
            rationale: 'An explicit correction from the journal owner.',
            scope: { kind: 'global_transcription' },
          },
          approval: 'pending' as 'approved',
        },
        csrfToken: 'csrf-token',
        idempotencyKey: 'remember-name',
      }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
