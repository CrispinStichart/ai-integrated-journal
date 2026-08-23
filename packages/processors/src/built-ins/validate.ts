import type { ProposedProcessorOutput } from '../runtime.js';
import {
  FOOD_AND_DRINK_PROCESSOR_KEY,
  validateFoodAndDrinkOutput,
} from './food-and-drink.js';
import { MOOD_PROCESSOR_KEY, validateMoodOutput } from './mood.js';

/** Routes immutable built-in semantic checks after generic schema validation. */
export function validateBuiltInProcessorOutput(
  processorKey: string,
  output: Pick<ProposedProcessorOutput, 'payload' | 'evidence'>,
): void {
  if (processorKey === FOOD_AND_DRINK_PROCESSOR_KEY)
    validateFoodAndDrinkOutput(output);
  if (processorKey === MOOD_PROCESSOR_KEY) validateMoodOutput(output);
}
