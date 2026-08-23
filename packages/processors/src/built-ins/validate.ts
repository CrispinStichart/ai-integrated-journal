import type { ProposedProcessorOutput } from '../runtime.js';
import {
  FOOD_AND_DRINK_PROCESSOR_KEY,
  validateFoodAndDrinkOutput,
} from './food-and-drink.js';
import { MOOD_PROCESSOR_KEY, validateMoodOutput } from './mood.js';
import {
  SLEEP_PROCESSOR_KEY,
  validateSleepAndTemporalOutput,
} from './sleep-and-temporal.js';
import {
  TASKS_AND_INTENTIONS_PROCESSOR_KEY,
  validateTasksAndIntentionsOutput,
} from './tasks-and-intentions.js';

/** Routes immutable built-in semantic checks after generic schema validation. */
export function validateBuiltInProcessorOutput(
  processorKey: string,
  output: Pick<ProposedProcessorOutput, 'payload' | 'evidence'>,
): void {
  if (processorKey === FOOD_AND_DRINK_PROCESSOR_KEY)
    validateFoodAndDrinkOutput(output);
  if (processorKey === MOOD_PROCESSOR_KEY) validateMoodOutput(output);
  if (processorKey === SLEEP_PROCESSOR_KEY)
    validateSleepAndTemporalOutput(output);
  if (processorKey === TASKS_AND_INTENTIONS_PROCESSOR_KEY)
    validateTasksAndIntentionsOutput(output);
}
