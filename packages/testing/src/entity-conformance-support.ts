// The small vocabulary every entity conformance check is written in: an outcome that is a value or
// a code (never a raw throw), an id from a suffix, an actor in an org, a typed handle per driver.

import { ctxOf, isUltimateError, runWithContext, userActor } from '@ultimat3/core';
import type { Database, Driver, EntitySet } from '@ultimat3/entity';
import { database } from '@ultimat3/entity';
import type { DriverCapability } from '@ultimat3/entity/adapter';
import type { EntityDriverCheck, EntityDriverRun } from './entity-driver-conformance';

export type Outcome = { readonly ok: unknown } | { readonly code: string };

/** The body's answer, or the code it refused with. */
export const outcome = async (work: () => Promise<unknown>): Promise<Outcome> => {
  try {
    return { ok: await work() };
  } catch (error) {
    return { code: isUltimateError(error) ? error.code : `not coded: ${String(error)}` };
  }
};

/** `'resolved'`, or the code — `'uncoded'` for a throw that carries none. */
export const codeOf = async (work: () => unknown): Promise<string> => {
  try {
    await work();
    return 'resolved';
  } catch (error) {
    return isUltimateError(error) ? error.code : 'uncoded';
  }
};

export const idAt = (suffix: string | number): string =>
  `00000000-0000-7000-8000-${String(suffix).padStart(12, '0')}`;

/** Inside a request whose actor belongs to `orgId`. */
export const inOrg = <T>(orgId: string, work: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: idAt('990'), orgId }) }), work);

/** A typed handle over the opened driver. */
export const handleOf = <E extends EntitySet>(entities: E, driver: Driver): Database<E> =>
  database(entities, { driver });

/**
 * One check over a set of tables, typed against them: `run` gets the handle `database()` builds
 * over exactly those tables, plus the raw run for a check that needs a bare repository.
 */
export const checkOver = <E extends EntitySet>(
  entities: E,
  name: string,
  run: (db: Database<E>, raw: EntityDriverRun) => Promise<void>,
  needs: readonly DriverCapability[] = [],
): EntityDriverCheck => ({
  name,
  entities: Object.values(entities),
  needs,
  run: (raw) => run(handleOf(entities, raw.driver), raw),
});
