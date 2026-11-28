// Single responsibility: say, once per custom driver, that its judged updates are unguarded — the
// store has no `updateChecked`, so a concurrent writer between the kit's judge and its write can
// leave a row no invariant would pass (#1379). Refusing is a break for every shipped driver, so in
// 31.x this is a coded `log.record` warning, as `X_ENTITY_ALL_TRUNCATED` is.

import { logger, renderCauseValue } from '@ultimat3/core';
import type { DriverDefinition, DriverRepo } from './driver-kit-types';
import { sameTenantProperties } from './driver-write-scope';
import type { EntityCore } from './entity';
import { versionOf } from './version-lock';

/** The one log message this writes: a subscriber matches `log.record`'s `message` against it. */
export const UNCHECKED_UPDATES = 'entity.driver.update_unchecked';

/** Drivers already warned about: keyed by the definition, so one `defineDriver` warns once. */
const warned = new WeakSet<DriverDefinition>();

/**
 * Called as each table opens. Silent for a store with `updateChecked`, for a table whose updates
 * judge nothing (no invariant, no same-tenant reference) and for a versioned one — its writes are
 * conditioned on the version already (`driver-versioned-write.ts`). Every environment: the race is
 * production's, and one line per driver per process costs nothing.
 */
export function noteUncheckedUpdates<Row>(
  definition: DriverDefinition,
  entity: EntityCore<Row>,
  raw: DriverRepo<Row>,
): void {
  if (typeof raw.updateChecked === 'function' || warned.has(definition)) return;
  const judged = entity.$invariants.length > 0 || sameTenantProperties(entity).size > 0;
  if (!judged || versionOf(entity) !== null) return;
  warned.add(definition);
  logger.warn(UNCHECKED_UPDATES, {
    code: 'X_DRIVER_UNSUPPORTED',
    capability: 'updateChecked',
    driver: definition.name,
    entity: entity.$name,
    cause: `driver ${renderCauseValue(definition.name)} has no updateChecked, so ${entity.$name}'s judged updates read, judge, then write unconditionally — a concurrent writer between the judge and the write can leave a row its invariants refuse`,
    fix: `defineDriver({ name: ${JSON.stringify(definition.name)}, capabilities, repo: (entity) => ({ ...store, updateChecked: async (filter, expected, patch) => /* atomically: rows filter matches deep-equal expected ? set patch, true : false */ }) })   # README "Custom drivers"`,
  });
}
