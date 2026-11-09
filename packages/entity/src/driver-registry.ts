// Single responsibility: which kinds of store this process has constructed a driver for, so a
// tool that loaded the app can tell a Postgres app from one whose rows live in a store that owns
// its own schema. `x verify`'s drift step reads it: migrations describe Postgres and nothing else.

/** `sql`: Postgres, whose schema `x db` owns. `custom`: a `defineDriver` store, which owns its own. */
export type DriverStoreKind = 'sql' | 'custom';

const constructed = new Map<DriverStoreKind, Set<string>>();

/** Called by every driver factory as it is built. Idempotent per name. */
export const noteDriverStore = (kind: DriverStoreKind, name: string): void => {
  const names = constructed.get(kind) ?? new Set<string>();
  names.add(name);
  constructed.set(kind, names);
};

/** The store names noted so far, per kind. A fresh view: the caller cannot edit the record. */
export const driverStores = (): Readonly<Record<DriverStoreKind, readonly string[]>> => ({
  sql: [...(constructed.get('sql') ?? [])].sort(),
  custom: [...(constructed.get('custom') ?? [])].sort(),
});

/** TEST SEAM: forget every noted store. */
export const clearDriverStores = (): void => {
  constructed.clear();
};
