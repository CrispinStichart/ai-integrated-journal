import {
  type DeletionTombstone,
  deletionTombstonePageSchema,
  permanentDeletionMutationResponseSchema,
  permanentDeletionPreviewSchema,
  type PermanentDeletionRequest,
} from '@journal/contracts';

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...init.headers,
    },
  });
  if (!response.ok)
    throw new Error(`Retention request failed (${response.status}).`);
  return response.status === 204 ? undefined : response.json();
}

export async function previewPermanentDeletion(
  target: Omit<PermanentDeletionRequest, 'confirmation'>,
  csrfToken: string,
) {
  return permanentDeletionPreviewSchema.parse(
    await request('/api/v1/retention/permanent-deletions/preview', {
      method: 'POST',
      headers: { 'x-csrf-token': csrfToken },
      body: JSON.stringify(target),
    }),
  );
}

export async function requestPermanentDeletion(
  target: Omit<PermanentDeletionRequest, 'confirmation'>,
  csrfToken: string,
) {
  return permanentDeletionMutationResponseSchema.parse(
    await request('/api/v1/retention/permanent-deletions', {
      method: 'POST',
      headers: { 'x-csrf-token': csrfToken },
      body: JSON.stringify({ ...target, confirmation: 'PERMANENTLY DELETE' }),
    }),
  );
}

export async function synchronizeDeletionLedger(afterGeneration: number) {
  return deletionTombstonePageSchema.parse(
    await request(
      `/api/v1/retention/tombstones?afterGeneration=${afterGeneration}&limit=500`,
    ),
  );
}

export async function drainDeletionLedger(
  initialGeneration: number,
  applyPage: (
    items: readonly DeletionTombstone[],
    generation: number,
  ) => Promise<void>,
): Promise<{ appliedGeneration: number; latestGeneration: number }> {
  let appliedGeneration = initialGeneration;
  for (;;) {
    const page = await synchronizeDeletionLedger(appliedGeneration);
    const pageGeneration = page.items.at(-1)?.generation ?? appliedGeneration;
    if (page.hasMore && pageGeneration <= appliedGeneration) {
      throw new Error('The deletion ledger did not make forward progress.');
    }
    if (page.items.length > 0) {
      await applyPage(page.items, pageGeneration);
      appliedGeneration = pageGeneration;
    }
    if (!page.hasMore) {
      return {
        appliedGeneration,
        latestGeneration: page.latestGeneration,
      };
    }
  }
}

export async function acknowledgeDeletionLedger(
  generation: number,
  csrfToken: string,
): Promise<void> {
  await request('/api/v1/retention/browser-purge-acknowledgements', {
    method: 'POST',
    headers: { 'x-csrf-token': csrfToken },
    body: JSON.stringify({ generation }),
  });
}
