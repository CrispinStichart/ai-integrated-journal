import { DomainInvariantError } from './errors.js';

export const memoryTypes = [
  'transcription_context',
  'known_entity',
  'alias',
  'correction_rule',
  'processor_rule',
  'known_fact',
  'application_preference',
] as const;

export type MemoryType = (typeof memoryTypes)[number];

export type FeedbackScope =
  | Readonly<{ kind: 'occurrence_only' }>
  | Readonly<{ kind: 'global_transcription' }>
  | Readonly<{ kind: 'processor'; processorId: string }>
  | Readonly<{ kind: 'global_known_fact' }>
  | Readonly<{ kind: 'global_application_preference' }>;

/**
 * Classifies feedback without inferring broad intent. An omitted or incomplete
 * request is deliberately local to the selected occurrence (FB-004).
 */
export function classifyFeedbackScope(
  input: Readonly<{
    requestedScope?: Exclude<FeedbackScope, { kind: 'occurrence_only' }>;
    memoryType?: MemoryType;
  }>,
): FeedbackScope {
  if (input.requestedScope === undefined || input.memoryType === undefined) {
    return { kind: 'occurrence_only' };
  }
  const scope = input.requestedScope;
  if (
    [
      'transcription_context',
      'known_entity',
      'alias',
      'correction_rule',
    ].includes(input.memoryType) &&
    scope.kind !== 'global_transcription'
  ) {
    throw new DomainInvariantError(
      'Transcription memories require the global transcription scope.',
    );
  }
  if (input.memoryType === 'processor_rule' && scope.kind !== 'processor') {
    throw new DomainInvariantError(
      'Processor rules require one exact processor scope.',
    );
  }
  if (input.memoryType === 'known_fact' && scope.kind !== 'global_known_fact') {
    throw new DomainInvariantError('Known facts require the known-fact scope.');
  }
  if (
    input.memoryType === 'application_preference' &&
    scope.kind !== 'global_application_preference'
  ) {
    throw new DomainInvariantError(
      'Application preferences require the application-preference scope.',
    );
  }
  return scope;
}

export function isTranscriptionMemory(type: MemoryType): boolean {
  return [
    'transcription_context',
    'known_entity',
    'alias',
    'correction_rule',
  ].includes(type);
}
