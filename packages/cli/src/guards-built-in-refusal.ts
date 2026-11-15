// `x g guard <shipped name>` refused: installing the framework is the one way to get a shipped
// guard (axiom 1), so writing a copy is a second path — and a copy runs in place of the installed
// guard, never receiving a fix. The refusal names the row that changes how it reports instead.

import { UltimateError } from '@ultimat3/core';
import { SHIPPED_GUARD_CONFIG } from './guards-built-in';
import { SHIPPED_GUARD_NAMES } from './templates/scaffold-guards';

/** A string here until the coordinator registers it in `error-codes.ts`. */
export const GUARD_BUILT_IN_CODE = 'X_GUARD_BUILT_IN';

export class GuardBuiltInError extends UltimateError {
  constructor(name: string) {
    super({
      code: GUARD_BUILT_IN_CODE,
      cause: `${name} is a guard the framework ships, and it already runs on x verify's boundaries step from the installed version — a copy in guards/ would run in its place and never receive a fix`,
      fix: `x verify --only boundaries --json   # ${name} already runs: set "${name}": "error", "warning" or "off" in ${SHIPPED_GUARD_CONFIG}, or x g guard app-${name} for a rule of your own`,
    });
  }
}

/** Throws for a shipped name (already kebab-cased, as the generator reads it); any other is the app's. */
export function refuseShippedGuardName(name: string): void {
  if (SHIPPED_GUARD_NAMES.includes(name)) throw new GuardBuiltInError(name);
}
