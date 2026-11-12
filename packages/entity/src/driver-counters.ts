// Single responsibility: refuse a `countedIn` counter on a `defineDriver` store. Postgres keeps one
// by trigger and memory in its repository; a custom store has no lifecycle hook, so its parent's
// count would never move — refused when the child's repository is built, never a silent stale count.

import { DriverError } from './driver-errors';
import type { EntityCore } from './entity';

/** The child's first property declaring `countedIn`, refused; nothing when it declares none. */
export function refuseCounters(driverName: string, entity: EntityCore): void {
  const counted = Object.entries(entity.$columns).find(
    ([, column]) => column.$meta.countedIn !== undefined,
  );
  if (counted === undefined) return;
  const [property] = counted;
  throw new DriverError({
    code: 'X_DRIVER_UNSUPPORTED',
    cause: `${entity.$name}.${property} declares countedIn, and driver ${JSON.stringify(driverName)} keeps no counter: a defineDriver store has no trigger or repository hook to move the parent's count`,
    fix: `database({ ${entity.$name}, … }, { driver: postgresDriver() })   # or memoryDriver(): both keep the counter — or drop countedIn from ${entity.$name}.${property} and count with db.${entity.$name}.countBy('${property}')`,
    meta: { capability: 'countedIn', driver: driverName, entity: entity.$name, property },
  });
}
