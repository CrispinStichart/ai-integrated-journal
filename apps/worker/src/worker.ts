import { processorsPackageName } from '@journal/processors';

export interface WorkerStatus {
  readonly dependencies: readonly string[];
  readonly service: '@journal/worker';
  readonly status: 'ready';
}

export function getWorkerStatus(): WorkerStatus {
  return {
    dependencies: [processorsPackageName],
    service: '@journal/worker',
    status: 'ready',
  };
}
