// The entity conformance suite's own registry bookkeeping and the capability probes: every fixture
// entity is `remember`ed so a neighbour's `clearRegistry()` cannot take it (relations read the
// registry), and `probes` is one call per `DriverCapability` an undeclared one must refuse.

import type { Driver, RegistryEntry } from '@ultimat3/entity';
import { database, entity, getEntity, integer, text, timestamp, uuid } from '@ultimat3/entity';
import type { DriverCapability } from '@ultimat3/entity/adapter';

const entries: RegistryEntry[] = [];

/** Every fixture entity the suite declared, as the registry held it at declaration. */
export const CONFORMANCE_ENTRIES: readonly RegistryEntry[] = entries;

/** Records a just-declared fixture entity's registry entry; answers the entity unchanged. */
export const remember = <E extends { readonly $name: string }>(made: E): E => {
  const entry = getEntity(made.$name);
  if (entry !== undefined) entries.push(entry);
  return made;
};

/** The table a capability probe opens: one row of every kind a probe needs. */
export const probe = remember(
  entity('ec_probe', {
    columns: { id: uuid().primaryKey(), label: text({ max: 20 }), n: integer(), at: timestamp() },
  }),
);

const PROBE_ROW = {
  id: '00000000-0000-7000-8000-0000000000e1',
  label: 'probe',
  n: 1,
  at: new Date('2026-01-01T00:00:00.000Z'),
};

/** One call per capability, each reaching the member `defineDriver` gates on that capability. */
export const probes = (driver: Driver): Readonly<Record<DriverCapability, () => unknown>> => {
  const repo = () => driver.repo(probe);
  const table = () => database({ probe }, { driver }).probe;
  return {
    transactions: () => driver.transactor(),
    lock: () => table().lock(PROBE_ROW.id, () => undefined),
    series: () => repo().series?.({ on: 'at', unit: 'day', timeZone: 'UTC', value: 'count' }),
    upsert: () => repo().upsertAll([PROBE_ROW], { onConflict: ['id'] }),
    matches: () => repo().findMany({ where: [{ column: '$search', op: 'matches', value: 'x' }] }),
    'aggregate:countBy': () => repo().countBy('label'),
    'aggregate:sum': () => repo().aggregate('sum', 'n'),
    'aggregate:avg': () => repo().aggregate('avg', 'n'),
    'aggregate:min': () => repo().aggregate('min', 'n'),
    'aggregate:max': () => repo().aggregate('max', 'n'),
    'aggregate:approximateCount': () => repo().approximateCount(),
  };
};
