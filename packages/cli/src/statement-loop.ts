// One repeated statement shape, as every surface renders it. The ledger next door decides that a
// shape repeated; `@ultimat3/entity` decides which fix it has earned; this file is the one
// projection all four surfaces read — so `x dev`'s findings, the `/_x` timeline, the browser
// overlay and the log line can never disagree about a loop's code, its cause or the line that ends it.

import type { StatementLoopFact } from '@ultimat3/admin/dev';
import { logger } from '@ultimat3/core';
import { nPlusOne } from '@ultimat3/entity';
import type { OverlayNotice } from '@ultimat3/http';
import type { RepeatedStatement } from './dev-n-plus-one';
import type { Finding } from './output';

/**
 * The verdict, as an error — built here rather than in the ledger because the count keeps rising
 * after a shape is promoted: a loop of fifty reads `ran 50 times` when a surface asks, not
 * `ran 5 times` because that is where the threshold sat. `nPlusOne` is `@ultimat3/entity`'s, and
 * deliberately: the `fix:` names `preload`, `insertAll` and `updateWhere`, which are that package's
 * vocabulary and derived from the relations the schema already declared — a line composed here
 * would be a second answer to "what ends this loop", one the schema never agreed to.
 */
export function loopFacts(repeat: RepeatedStatement): StatementLoopFact {
  const attribution = repeat.attribution;
  const error = nPlusOne({
    kind: repeat.kind,
    subject: repeat.fingerprint,
    count: repeat.count,
    entity: attribution?.entity,
    op: attribution?.op,
  });
  return {
    requestId: repeat.requestId,
    code: error.code,
    cause: error.cause,
    fix: error.fix,
    docs: error.docs ?? null,
    subject: repeat.fingerprint,
    count: repeat.count,
    sample: repeat.sample,
  };
}

/**
 * The `x dev` half. `at` is the request id and not a file: a loop has no line to open — it is a
 * page's worth of statements — and the id is what joins this finding to the timeline's own row and
 * to the log line the same request emitted.
 */
export const loopFinding = (facts: StatementLoopFact): Finding => ({
  code: facts.code,
  cause: facts.cause,
  fix: facts.fix,
  at: facts.requestId,
  ...(facts.docs === null ? {} : { docs: facts.docs }),
});

/** The browser half. `exactOptionalPropertyTypes`: an absent doc link is omitted, never `undefined`. */
export const loopNotice = (facts: StatementLoopFact): OverlayNotice => ({
  code: facts.code,
  cause: facts.cause,
  fix: facts.fix,
  ...(facts.docs === null ? {} : { docs: facts.docs }),
});

/**
 * The log half, emitted once per request per code by the ledger that counts.
 *
 * The root logger and not `ctx.logger`, because this runs inside the request's own ALS scope and
 * core's `setLoggerContextFields` puts `requestId` and `traceId` on every line emitted there — so
 * the ids ride along without this file reaching for a context it would then have to prove it had.
 * One line, in the 3-line contract's own order, because a warning an agent has to reassemble from
 * three log records is a warning it acts on in three passes.
 */
export const warnLoop = (facts: StatementLoopFact): void => {
  logger.warn(`${facts.code}: ${facts.cause} — fix: ${facts.fix}`);
};
