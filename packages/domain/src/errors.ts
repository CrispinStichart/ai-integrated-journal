export class DomainInvariantError extends Error {
  override readonly name: string = 'DomainInvariantError';
}

export class InvalidStateTransitionError extends DomainInvariantError {
  override readonly name = 'InvalidStateTransitionError';

  constructor(
    readonly stateMachine: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Invalid ${stateMachine} transition from "${from}" to "${to}".`);
  }
}

export class OptimisticConcurrencyError extends DomainInvariantError {
  override readonly name = 'OptimisticConcurrencyError';

  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Stale write: expected version ${expectedVersion}, current version is ${actualVersion}.`,
    );
  }
}
