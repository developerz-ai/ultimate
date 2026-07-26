/**
 * Domain error codes. Bare `Error` is banned framework-wide; an invariant break must carry the
 * invariant's name and the fix, because it is usually read by an agent, not a human.
 */

import { UltimateError } from '@ultimat3/core';

export class DomainError extends UltimateError {}

export class InvariantViolation extends DomainError {
  constructor(details: { invariant: string; cause: string; fix: string }) {
    super({
      code: 'X_DOMAIN_INVARIANT',
      cause: `${details.invariant}: ${details.cause}`,
      fix: details.fix,
      docs: 'https://ultimate.dev/errors/X_DOMAIN_INVARIANT',
    });
  }
}
