// Single responsibility: the two refusals the shared exercise loop raises BEFORE a run, so an
// action's and a query's exercise refuse the same way. Off the socket: each is raised in a test
// process or a script, never served. The verdict codes (`X_CONTRACT_DEFECT`, …) stay action's.

import { renderFixShellArg } from './error-render';
import { UltimateError } from './errors';

/**
 * Not `development` or `test`: a deployed process. The exercise calls a handler with generated
 * input, and mail, storage, outbound fetch and a non-outbox enqueue are not rolled back with the
 * transaction — against a deploy those are real.
 */
export class ExerciseEnvironmentError extends UltimateError {
  static readonly code = 'X_CONTRACT_EXERCISE_ENVIRONMENT';
  override readonly name = 'ExerciseEnvironmentError';
  constructor(subject: string, environment: string) {
    super({
      code: ExerciseEnvironmentError.code,
      cause: `${subject} was exercised in the ${environment} environment: generated input would run against a deploy, and mail, storage, outbound fetch and non-outbox jobs are never rolled back`,
      fix: `bun test <the file calling ${renderFixShellArg(subject, '<name>')}.contract()>   # under bun test (NODE_ENV=test) — never with ULTIMATE_ENV=${environment}`,
      meta: { environment },
    });
  }
}

/**
 * No transaction can be opened that the writes would join, outside `test`: the handler's writes
 * would land on the process's lazy pool (`DATABASE_URL`) and be kept.
 */
export class ExerciseUnscopedError extends UltimateError {
  static readonly code = 'X_CONTRACT_EXERCISE_UNSCOPED';
  override readonly name = 'ExerciseUnscopedError';
  constructor(subject: string, environment: string) {
    super({
      code: ExerciseUnscopedError.code,
      cause: `${subject} was exercised in ${environment} with no database client installed and no transaction open, so its writes could not be rolled back`,
      fix: `setDbClient(<a test database client>) from @ultimat3/db before ${renderFixShellArg(subject, '<name>')}.contract()   # or run it under bun test (NODE_ENV=test)`,
      meta: { environment },
    });
  }
}
