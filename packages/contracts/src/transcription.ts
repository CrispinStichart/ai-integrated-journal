import { z } from 'zod';

import { uuidV7Schema } from './primitives.js';

export const recordingTranscriptionSchema = z.strictObject({
  state: z.enum(['not_started', 'queued', 'running', 'succeeded', 'failed']),
  runId: uuidV7Schema.optional(),
});

export type RecordingTranscriptionResource = z.infer<
  typeof recordingTranscriptionSchema
>;
