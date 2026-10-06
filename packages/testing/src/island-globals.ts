// The process globals the island fixture installs, as LAYERS over one snapshot of the real ones.
// Each mount used to save what it found and restore that on dispose — right only newest-first: a
// worker disposing A then B had B "restore" A's fake `document`/`Element` for every later file.

/** One mount's globals, newest last. */
const layers: Readonly<Record<string, unknown>>[] = [];

/**
 * The REAL descriptor of every key any live layer installs, taken the first time a layer installs
 * it while no other live layer holds it — so 0→1 for each key — and put back only when the last
 * layer goes (1→0). `undefined` is "no such global", which is restored as a delete.
 *
 * DESCRIPTORS, not values: a saved value cannot tell "no such global" from "a global holding
 * `undefined`", and it cannot put an accessor back as an accessor.
 */
const real = new Map<string, PropertyDescriptor | undefined>();

const host = globalThis as unknown as Record<string, unknown>;

const putBack = (key: string, descriptor: PropertyDescriptor | undefined): void => {
  if (descriptor === undefined) delete host[key];
  else Object.defineProperty(host, key, descriptor);
};

/**
 * The process as the remaining layers say it should be: each key holds the NEWEST live layer's
 * value, and a key no live layer names is real again. Assignment for a layer's value, for
 * `installGlobals`' reason — a global with a setter is meant to see the write.
 */
function settle(): void {
  for (const [key, descriptor] of real) {
    const owner = layers.findLast((layer) => Object.hasOwn(layer, key));
    if (owner !== undefined) {
      host[key] = owner[key];
      continue;
    }
    putBack(key, descriptor);
    real.delete(key);
  }
}

/**
 * Install `values` over the process, answering the undo. All-or-nothing: an assignment that throws
 * — a getter-only own global among the caller's `globals` — settles the process back before it
 * rethrows, or the fake `document` installed ahead of it would stay for the rest of the run.
 *
 * The undo is idempotent and ORDER-FREE: it removes this layer and settles, so whichever mount
 * goes last hands the process the real globals, and a mount disposed while a newer one lives
 * leaves the newer one's in place.
 */
export function installGlobals(values: Readonly<Record<string, unknown>>): () => void {
  for (const key of Object.keys(values)) {
    if (!real.has(key)) real.set(key, Object.getOwnPropertyDescriptor(host, key));
  }
  const layer = { ...values };
  layers.push(layer);
  let removed = false;
  const remove = (): void => {
    if (removed) return;
    removed = true;
    layers.splice(layers.indexOf(layer), 1);
    settle();
  };
  try {
    // Assignment, not `defineProperty`: `Object.assign` over the lot would report the same
    // failure with nothing rolled back.
    for (const [key, value] of Object.entries(values)) host[key] = value;
  } catch (error) {
    remove();
    throw error;
  }
  return remove;
}
