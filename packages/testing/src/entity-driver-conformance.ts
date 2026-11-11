// The entity `Driver` contract as shared examples: `behavesLike(entityDriverConformance, () =>
// subject)` runs every check against a driver of your own — `memoryDriver()`, `postgresDriver()`, a
// `defineDriver({ … })` store. Behaviour through the typed handle only, never SQL text: what a
// caller of `db.<table>` is promised, whichever driver answers.

import { expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { Driver, EntityCore } from '@ultimat3/entity';
import { getEntity, registerEntity } from '@ultimat3/entity';
import type { DriverCapability } from '@ultimat3/entity/adapter';
import { ENTITY_DRIVER_CHECKS } from './entity-conformance-checks';
import { CONFORMANCE_ENTRIES, probe, probes } from './entity-conformance-entities';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

/** What a driver under test hands the suite. Called once per check. */
export interface EntityDriverSubject {
  /**
   * A driver over EMPTY tables for `entities`: a SQL store drops and re-creates them from the
   * entities' own migration (`generateMigration`), a memory store builds a fresh driver.
   */
  open(entities: readonly EntityCore[]): Driver | Promise<Driver>;
  /** What the driver declares beyond the five required methods — `DRIVER_CAPABILITIES` for all. */
  readonly capabilities: readonly DriverCapability[];
  /** Whether a reference to a row that does not exist is refused (`X_DB_FOREIGN_KEY_VIOLATION`). */
  readonly foreignKeys: boolean;
  /**
   * Whether the store records `entity({ history: true })` — Postgres by trigger, memory in its
   * repository. A `defineDriver` store has no lifecycle hook, so it records nothing and refuses
   * nothing: absent here, the history check is not run against it (there is no refusal to assert).
   */
  readonly history?: boolean;
}

/** What one check sees: the opened driver, and the subject's declared traits. */
export interface EntityDriverRun {
  readonly driver: Driver;
  readonly foreignKeys: boolean;
  /** The subject's `history`, `false` when it declared none. */
  readonly history: boolean;
}

export interface EntityDriverCheck {
  readonly name: string;
  /** The tables the check reads and writes; `open` creates exactly these. */
  readonly entities: readonly EntityCore[];
  /** Capabilities the check exercises. Undeclared by the subject: the refusal is the check. */
  readonly needs?: readonly DriverCapability[];
  run(run: EntityDriverRun): Promise<void>;
}

const refusalOf = async (work: () => unknown): Promise<unknown> => {
  try {
    await work();
  } catch (error) {
    return isUltimateError(error) ? [error.code, error.meta?.['capability']] : String(error);
  }
  return 'resolved';
};

/**
 * A capability the subject does not declare is not skipped — it is asserted REFUSED, by name, the
 * way `defineDriver` promises (`X_DRIVER_UNSUPPORTED`, or the typed handle's `X_LOCK_UNSUPPORTED`).
 * So every check is a claim either way, and a driver that half-implements one is found out.
 */
const assertRefused = async (driver: Driver, capability: DriverCapability): Promise<void> => {
  const answered = await refusalOf(() => probes(driver)[capability]());
  const expected =
    capability === 'lock'
      ? ['X_LOCK_UNSUPPORTED', undefined]
      : ['X_DRIVER_UNSUPPORTED', capability];
  expect({ capability, answered }).toEqual({ capability, answered: expected });
};

/** Put back fixture entities a neighbouring file's `clearRegistry()` took: relations read it. */
const restoreFixtures = (): void => {
  for (const entry of CONFORMANCE_ENTRIES) {
    if (getEntity(entry.name) === undefined) registerEntity(entry);
  }
};

export const runEntityDriverCheck = async (
  check: EntityDriverCheck,
  subject: EntityDriverSubject,
): Promise<void> => {
  restoreFixtures();
  const missing = (check.needs ?? []).filter((need) => !subject.capabilities.includes(need));
  const driver = await subject.open(missing.length > 0 ? [probe] : check.entities);
  if (missing.length > 0) {
    for (const capability of missing) await assertRefused(driver, capability);
    return;
  }
  await check.run({ driver, foreignKeys: subject.foreignKeys, history: subject.history === true });
};

/** Generous: a SQL subject re-creates its tables per check, and one check writes 40,000 rows. */
const CHECK_TIMEOUT_MS = 60_000;

export const entityDriverConformance: SharedExamples<
  EntityDriverSubject | Promise<EntityDriverSubject>
> = sharedExamples('an entity driver', (subject) => {
  for (const check of ENTITY_DRIVER_CHECKS) {
    test(
      check.name,
      async () => {
        await runEntityDriverCheck(check, await subject());
      },
      CHECK_TIMEOUT_MS,
    );
  }
});
