import { and, asc, eq, sql } from 'drizzle-orm';

import type { RepositoryContext } from './client.js';
import { memories, memoryRevisions } from './schema.js';

export const MAX_STT_MEMORY_CONTEXT_ITEMS = 64;
export const MAX_STT_MEMORY_CONTEXT_UTF16 = 8_000;

export type VersionedMemoryContextItem = Readonly<{
  text: string;
  purpose: string;
  version: string;
  memoryId: string;
  memoryRevisionId: string;
}>;

/** Builds a deterministic, bounded snapshot from visible owner-approved state. */
export async function assembleApprovedTranscriptionContext(
  context: RepositoryContext,
  ownerId: string,
): Promise<readonly VersionedMemoryContextItem[]> {
  const rows = await context
    .select({ memory: memories, revision: memoryRevisions })
    .from(memories)
    .innerJoin(
      memoryRevisions,
      eq(memoryRevisions.id, memories.currentRevisionId),
    )
    .where(
      and(
        eq(memories.ownerId, ownerId),
        eq(memories.approvalState, 'approved'),
        eq(memories.enabled, true),
        sql`${memories.deletedAt} is null`,
        sql`${memoryRevisions.scope}->>'kind' = 'global_transcription'`,
      ),
    )
    .orderBy(asc(memories.id))
    .limit(MAX_STT_MEMORY_CONTEXT_ITEMS);
  const output: VersionedMemoryContextItem[] = [];
  let used = 0;
  for (const { memory, revision } of rows) {
    if (
      ![
        'transcription_context',
        'known_entity',
        'alias',
        'correction_rule',
      ].includes(revision.type)
    )
      continue;
    if (used + revision.content.length > MAX_STT_MEMORY_CONTEXT_UTF16) break;
    output.push({
      text: revision.content,
      purpose: `memory:${revision.type}`,
      version: revision.id,
      memoryId: memory.id,
      memoryRevisionId: revision.id,
    });
    used += revision.content.length;
  }
  return output;
}
