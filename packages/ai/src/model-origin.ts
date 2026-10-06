// Which catalogue rows this package registered and which the app did. Both go through the one
// public `registerModel`, so origin is a mark set around the built-in registrations — never a
// second registry — and the app restating a built-in id makes that row the app's.

import type { ModelId } from './models';

const builtIn = new Set<ModelId>();
let registeringBuiltIns = 0;

/** Run the package's own registrations; every row they write is marked built-in. */
export function asBuiltIn(register: () => void): void {
  registeringBuiltIns += 1;
  try {
    register();
  } finally {
    registeringBuiltIns -= 1;
  }
}

/** Called by `registerModel` for every row it writes, last writer wins. */
export function markRegistered(id: ModelId): void {
  if (registeringBuiltIns > 0) builtIn.add(id);
  else builtIn.delete(id);
}

/** The row behind `id` is still the package's own: no `registerModel` from the app replaced it. */
export function isBuiltInRow(id: ModelId): boolean {
  return builtIn.has(id);
}

/** `resetModels()` empties the registry, and with it every origin. */
export function clearOrigins(): void {
  builtIn.clear();
}
