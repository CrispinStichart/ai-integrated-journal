import { InvalidStateTransitionError } from './errors.js';

export type ProcessingStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'insufficient_information'
  | 'stale'
  | 'failed'
  | 'canceled'
  | 'superseded';

const PROCESSING_TRANSITIONS: Readonly<
  Record<ProcessingStatus, readonly ProcessingStatus[]>
> = {
  queued: ['running', 'failed', 'canceled', 'superseded'],
  running: [
    'succeeded',
    'insufficient_information',
    'stale',
    'failed',
    'canceled',
    'superseded',
  ],
  succeeded: ['stale', 'superseded'],
  insufficient_information: ['stale', 'superseded'],
  stale: ['superseded'],
  failed: ['superseded'],
  canceled: ['superseded'],
  superseded: [],
};

export function canTransitionProcessing(
  from: ProcessingStatus,
  to: ProcessingStatus,
): boolean {
  return PROCESSING_TRANSITIONS[from].includes(to);
}

export function transitionProcessing(
  from: ProcessingStatus,
  to: ProcessingStatus,
): ProcessingStatus {
  if (!canTransitionProcessing(from, to)) {
    throw new InvalidStateTransitionError('processing lifecycle', from, to);
  }
  return to;
}

export function isTerminalProcessingStatus(status: ProcessingStatus): boolean {
  return PROCESSING_TRANSITIONS[status].length === 0;
}

export type RequirementEvaluationStatus =
  | 'not_evaluated'
  | 'satisfied'
  | 'insufficient_information'
  | 'pending_user_response'
  | 'dismissed'
  | 'not_applicable'
  | 'failed';

const REQUIREMENT_TRANSITIONS: Readonly<
  Record<RequirementEvaluationStatus, readonly RequirementEvaluationStatus[]>
> = {
  not_evaluated: [
    'satisfied',
    'insufficient_information',
    'not_applicable',
    'failed',
  ],
  satisfied: ['not_evaluated'],
  insufficient_information: ['pending_user_response', 'not_evaluated'],
  pending_user_response: [
    'satisfied',
    'dismissed',
    'not_applicable',
    'not_evaluated',
  ],
  dismissed: ['not_evaluated'],
  not_applicable: ['not_evaluated'],
  failed: ['not_evaluated'],
};

export function transitionRequirementEvaluation(
  from: RequirementEvaluationStatus,
  to: RequirementEvaluationStatus,
): RequirementEvaluationStatus {
  if (!REQUIREMENT_TRANSITIONS[from].includes(to)) {
    throw new InvalidStateTransitionError('requirement evaluation', from, to);
  }
  return to;
}
