// The three ways a fault drill ends red. Declared in `errors.ts` with this package's codes, thrown
// from here: a drill whose service is missing is REFUSED, never skipped — a green drill that ran
// nothing is the vacuous pass — a drill whose property failed names the property and evidence, and
// a scratch database the teardown could not drop is named with the paste that drops it.

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

/** A paste that does by hand what the drop could not: terminate the slot holder, then drop. */
function dropFix(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  const db = renderFixShellArg(database, '<database>');
  const host = renderFixShellArg(url.hostname, '<host>');
  const port = renderFixShellArg(url.port || '5432', '<port>');
  const user = renderFixShellArg(decodeURIComponent(url.username), '<user>');
  const admin = renderFixShellArg(url.pathname.slice(1) || 'postgres', '<admin database>');
  return (
    `psql -h ${host} -p ${port} -U ${user} -d ${admin}` +
    ` -c "select pg_terminate_backend(active_pid) from pg_replication_slots where database = '${db}'"` +
    ` -c 'select pg_sleep(1)' -c 'DROP DATABASE IF EXISTS ${db} WITH (FORCE)'`
  );
}

/**
 * The fleet's scratch database outlived its drop: a slot still held after its holder was
 * terminated, or the server refused. The password is never in the fix — psql asks for it.
 */
export class DrillTeardownFailedError extends UltimateError {
  constructor(input: {
    readonly database: string;
    readonly adminUrl: string;
    readonly why: string;
  }) {
    super({
      code: 'X_DRILL_TEARDOWN_FAILED',
      cause: `x drill could not drop its scratch database ${renderCauseValue(input.database)}: ${input.why}; it is left on the server`,
      fix: dropFix(input.adminUrl, input.database),
      meta: { database: input.database },
    });
  }
}
