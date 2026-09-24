// Single responsibility: how `defineConfig` layers `app.config.ts` and its `config/*.ts` overlays —
// per section and key by key. Carries no config KEY on purpose: `config-readers` counts a property
// access outside `config.ts` as a reader, so this file only ever sees sections as opaque records.

/** A section's patch: every key optional, and an explicit `undefined` meaning "not said". */
export type Input<T> = { readonly [K in keyof T]?: T[K] | undefined };

/**
 * Apply a partial section over its defaults. Explicit `undefined` never wins — that is what
 * makes every config field deeply optional without `exactOptionalPropertyTypes` fighting back.
 */
export function section<T extends object>(base: T, patch: Input<T> | undefined): T {
  if (patch === undefined) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

/**
 * Every layer's patch applied in order, each one KEY BY KEY. The input and the overlays used to be
 * `Object.assign`ed first and the section merged once, so `{ jobs: { maxAttempts: 9 } }` in an
 * overlay replaced the base's whole `jobs` patch — its `queues` and `concurrency` fell back to the
 * framework defaults — and an overlay's `{ realtime: undefined }` erased the base's section.
 */
export function layered<T extends object>(base: T, patches: readonly (Input<T> | undefined)[]): T {
  return patches.reduce<T>((out, patch) => section(out, patch), base);
}

/** A whole-value key (`locales`, `roles`): the last layer that said something wins. */
export function lastSaid<T>(base: T, values: readonly (T | undefined)[]): T {
  let out = base;
  for (const value of values) if (value !== undefined) out = value;
  return out;
}
