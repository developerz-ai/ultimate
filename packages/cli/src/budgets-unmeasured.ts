// Single responsibility: the finding for a budgeted route a build RAN and could not weigh, read off
// the static report's `unmeasured` entry — under the failure's own code when that code is the
// instruction, as an actor edit when the measurement actor was refused, the report otherwise.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { Finding } from './output';
import type { UnmeasuredRoute } from './static-report';

/**
 * The ONE code a failed measurement is reported under by its own name rather than as
 * `X_BUDGET_UNMEASURED`. Its cause is complete — the island, the prop, its bytes, the cap — and
 * its fix is an edit to the page, so the step's own "run x build and read the list" would put a
 * second command between the author and a sentence the build had already composed. Every other
 * render failure keeps the generic finding: a `TypeError` from a `load` that wanted a request is
 * a reason to read the report, not an instruction.
 *
 * ONE code and not "any coded error", deliberately. `X_NO_CONTEXT` and `X_DB_UNAVAILABLE` from a
 * measurement render are facts about the BUILD's environment, and reporting them under their own
 * codes would tell the author to fix a database the gate never had. The list grows by a decision,
 * per code, here.
 */
const REPORTED_BY_OWN_CODE: ReadonlySet<string> = new Set([
  'X_ISLAND_PROPS_INVALID',
  // A dynamic route that lists no `prerender()` path: the edit is in the route, not the build.
  'X_BUDGET_PARAMS_UNDECLARED',
]);

/**
 * Refusals of WHO the render ran as. The actor is the app's own declaration (core's
 * `defineMeasurementActor`, in `app.config.ts`), so these ARE an instruction — but the refusal's
 * own `fix:` was written for a request ("sign in", "mint the actor with its tenant at the request
 * boundary") and names no build-time edit. The default actor is a service actor holding `*` with
 * no org and no roles: a page whose policy names a role, or whose `load` reads a tenant-scoped
 * entity, is refused under it (#675).
 */
const ACTOR_REFUSALS: ReadonlySet<string> = new Set([
  'X_FORBIDDEN',
  'X_UNAUTHENTICATED',
  'X_TENANCY_ACTOR_ORG_REQUIRED',
]);

function ownCodeFinding(url: string, entry: UnmeasuredRoute): Finding {
  return {
    code: entry.code ?? 'X_BUDGET_UNMEASURED',
    cause: entry.cause ?? entry.reason,
    fix: entry.fix ?? `x build --target static --json   # its "unmeasured" list has ${url}`,
    docs: ERROR_DOCS_URL,
    at: url,
  };
}

/** `CODE: cause` when the failure had a code, its rendered reason otherwise. */
const refusalOf = (entry: UnmeasuredRoute): string =>
  entry.code === undefined ? entry.reason : `${entry.code}: ${entry.cause ?? entry.reason}`;

/**
 * A build ran and has no row for `url`. `entry` is the report's account of why, when it has one:
 * an instruction under its own code, an actor edit, or — for a failure that is a fact about the
 * build's environment — the report, with the refusal already in the cause.
 */
export function builtUnmeasuredFinding(
  url: string,
  declared: string,
  statsFile: string,
  entry: UnmeasuredRoute | undefined,
): Finding {
  if (entry?.code !== undefined && REPORTED_BY_OWN_CODE.has(entry.code)) {
    return ownCodeFinding(url, entry);
  }
  const base = `${url} declares a ${declared} budget and ${statsFile} has no row for it, so the build ran and could not weigh it`;
  if (entry?.code !== undefined && ACTOR_REFUSALS.has(entry.code)) {
    const actor = entry.actor ?? 'the measurement actor';
    return {
      code: 'X_BUDGET_UNMEASURED',
      cause: `${base}: rendered as ${actor}, it was refused ${refusalOf(entry)}`,
      // The paste: one declaration in the one file every build imports.
      fix: "defineMeasurementActor(() => userActor({ id: 'measure', orgId: '<an org your dev seed creates>', roles: ['<the role this page requires>'] }))   # in app.config.ts",
      docs: ERROR_DOCS_URL,
      at: url,
    };
  }
  return {
    code: 'X_BUDGET_UNMEASURED',
    cause: entry === undefined ? base : `${base}: ${refusalOf(entry)}`,
    // When a build already ran, the report is where the rest of the answer is — it names every
    // route it could not weigh, and why.
    fix: `x build --target static --json   # its "unmeasured" list says why ${url} could not be weighed`,
    docs: ERROR_DOCS_URL,
    at: url,
  };
}
