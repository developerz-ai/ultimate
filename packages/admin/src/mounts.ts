// Which admins this process declared, by base path — what a host reads to MOUNT them. Kept on the
// global symbol registry rather than in a module variable so the host can ask "did this app
// declare an admin?" WITHOUT importing this package: importing it loads every screen, and an app
// with no admin must not pay for one (axiom 6).

import type { AdminApp } from './admin';

/** The global key. `@ultimat3/cli`'s `runtime-admin.ts` restates the string; a test holds them equal. */
export const ADMIN_MOUNTS: symbol = Symbol.for('ultimate.admin.mounts');

type Mounts = Map<string, AdminApp>;

const mounts = (): Mounts => {
  const scope = globalThis as { [key: symbol]: unknown };
  const held = scope[ADMIN_MOUNTS];
  if (held instanceof Map) return held as Mounts;
  const created: Mounts = new Map();
  scope[ADMIN_MOUNTS] = created;
  return created;
};

/**
 * Called by `defineAdmin()`. Keyed by base path and last-wins: `x dev` re-evaluates the module
 * that declares the admin when it changes, and the admin a request then meets has to be the one
 * the author just saved.
 */
export function registerAdminMount(app: AdminApp): void {
  mounts().set(app.basePath, app);
}

/** Every declared admin, in declaration order. */
export function adminMounts(): readonly AdminApp[] {
  return [...mounts().values()];
}

/** The admin declared at `basePath` NOW, or `undefined`. Read per request, never captured. */
export function adminMountAt(basePath: string): AdminApp | undefined {
  return mounts().get(basePath);
}

/** Test seam; a running process never forgets an admin it declared. */
export function clearAdminMounts(): void {
  mounts().clear();
}
