// The admins `defineAdmin()` mounted, put back at the file boundary to what the file inherited:
// ~50 admin suites mount one and never clear it, and the `i18n` step audits EVERY mounted admin,
// so on a shared worker one file's admin was a later file's X_CATALOG_MISSING_KEYS.

/**
 * `@ultimat3/admin`'s `ADMIN_MOUNTS`, restated as `@ultimat3/cli`'s `runtime-admin.ts` does —
 * never imported: `testing` is tier 5 beside `admin`, and an app with no admin must not load one.
 */
const ADMIN_MOUNTS = Symbol.for('ultimate.admin.mounts');

type Mounted = readonly (readonly [string, unknown])[];

const held = (): Map<string, unknown> | undefined => {
  const value = (globalThis as { [key: symbol]: unknown })[ADMIN_MOUNTS];
  return value instanceof Map ? (value as Map<string, unknown>) : undefined;
};

/** Every mount by base path, in declaration order; nothing while no admin was ever declared. */
export function captureAdminMounts(): Mounted {
  return [...(held() ?? new Map<string, unknown>())];
}

/** Exactly `mounted` again, in its order — the same Map, so a reader holding it sees the change. */
export function restoreAdminMounts(mounted: Mounted): void {
  const live = held();
  if (live === undefined) return;
  live.clear();
  for (const [basePath, app] of mounted) live.set(basePath, app);
}
