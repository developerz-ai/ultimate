// The two ways a fault drill ends red. Declared in `errors.ts` with this package's codes, thrown
// from here: a drill whose service is missing is REFUSED, never skipped — a green drill that ran
// nothing is the vacuous pass — and a drill whose property failed names the property and evidence.

import { renderCauseValue, renderFixShellArg, UltimateError } from '@ultimat3/core';
import type { DrillFailure } from './drill-verdict';

const DRILL_PLACEHOLDER = '<the drill the cause names>';

export type DrillServiceGap =
  /** The service is not running where the drill can reach it: its `TEST_*` URL is unset. */
  | { readonly kind: 'unset'; readonly variable: string }
  /** The app declares no use of the service, so faulting it would prove nothing. */
  | { readonly kind: 'undeclared'; readonly declaration: string };

export class DrillServiceMissingError extends UltimateError {
  constructor(input: { readonly drill: string; readonly gap: DrillServiceGap }) {
    const { gap } = input;
    super({
      code: 'X_DRILL_SERVICE_MISSING',
      cause:
        gap.kind === 'unset'
          ? `x drill ${renderCauseValue(input.drill)} needs ${gap.variable}, and it is unset: a drill with no service to fault is refused, never passed`
          : `x drill ${renderCauseValue(input.drill)} faults a service this app does not use (${gap.declaration}), so it would prove nothing`,
      fix:
        gap.kind === 'unset'
          ? 'docker compose -f docker/docker-compose.test.yml up -d --wait   # then: set -a; . docker/test-services.env; set +a'
          : `x drill --list --json   # pick a drill this app declares the service for, or declare it in app.config.ts: ${gap.declaration}`,
      meta: { drill: input.drill, gap: gap.kind },
    });
  }
}

/** One failed property, as a thrown error or as the cause and fix of a CLI finding. */
export class DrillFailedError extends UltimateError {
  constructor(input: { readonly drill: string; readonly failure: DrillFailure }) {
    const { failure } = input;
    super({
      code: 'X_DRILL_FAILED',
      cause: `x drill ${renderCauseValue(input.drill)}: ${failure.property} did not hold — expected ${failure.expected}; observed ${renderCauseValue(failure.observed)}`,
      fix: `x drill ${renderFixShellArg(input.drill, DRILL_PLACEHOLDER)} --json   # read ${failure.property} and its evidence, then explain the code that evidence names: x errors explain <CODE>`,
      meta: { drill: input.drill, property: failure.property },
    });
  }
}
