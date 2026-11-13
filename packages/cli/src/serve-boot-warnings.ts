// The roles each boot warning concerns, in one table, and the step that runs the post-load ones for
// the booting role alone. Production logged the same warnings in all five roles on every boot — a
// warning a role cannot act on is noise that buries the one it can.

import type { Role } from '@ultimat3/core';

/** Every warning a container boot can say. A new one does not compile until it names its roles. */
export type BootWarning =
  | 'idempotency-process-scoped'
  | 'mfa-secret-unsealed'
  | 'build-id-unstamped'
  | 'auth-unconfigured'
  | 'rate-limit-process-scoped';

const DECLARED: Readonly<Record<BootWarning, readonly Role[]>> = {
  // An `Idempotency-Key` arrives on an HTTP request or an MCP call, both the web role's: a job
  // invokes its action on the `job` surface with no key, and `sync` relays frames, not writes.
  'idempotency-process-scoped': ['web'],
  // The second factor is asked for where a user signs in.
  'mfa-secret-unsealed': ['web'],
  // Only a background load leaves pages out, so only it pays to import them for the build id.
  'build-id-unstamped': ['worker', 'scheduler'],
  // Guarded routes are served by the web role alone; every other role is handed none.
  'auth-unconfigured': ['web'],
  // A declared `rateLimit:` is spent wherever a primitive runs: HTTP and MCP on web, `.job()` on a
  // worker, a live query's reads on sync. The scheduler only enqueues; the replicator invokes none.
  'rate-limit-process-scoped': ['web', 'worker', 'sync'],
};

/** A `Map`, so a lookup is an own-key read — never a member of `Object.prototype`. */
export const BOOT_WARNINGS: ReadonlyMap<BootWarning, readonly Role[]> = new Map(
  Object.entries(DECLARED) as [BootWarning, readonly Role[]][],
);

/** Whether `warning` is one `role` can act on. An unknown warning concerns nobody. */
export const bootWarningConcerns = (warning: BootWarning, role: Role): boolean =>
  BOOT_WARNINGS.get(warning)?.includes(role) ?? false;

/** Whether any of `roles` — `x dev` runs several in one process — can act on `warning`. */
export const bootWarningConcernsAny = (warning: BootWarning, roles: readonly Role[]): boolean =>
  roles.some((role) => bootWarningConcerns(warning, role));

/** The post-load probes: each logs its own line and answers whether it had anything to say. */
export interface BootWarningProbes {
  readonly idempotency: () => boolean;
  readonly mfa: () => Promise<number>;
}

/** Runs the probes `role` is concerned by, in table order; answers the warnings actually said. */
export async function warnAtBoot(
  role: Role,
  probes: BootWarningProbes,
): Promise<readonly BootWarning[]> {
  const said: BootWarning[] = [];
  if (bootWarningConcerns('idempotency-process-scoped', role) && probes.idempotency()) {
    said.push('idempotency-process-scoped');
  }
  if (bootWarningConcerns('mfa-secret-unsealed', role) && (await probes.mfa()) > 0) {
    said.push('mfa-secret-unsealed');
  }
  return said;
}
