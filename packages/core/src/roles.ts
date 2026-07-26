// Single responsibility: the runtime role table. One image, N processes; `ROLE` selects
// behaviour. Every role exposes /healthz + /readyz and drains on SIGTERM.

import { UltimateError } from './errors';

export const ROLES = ['web', 'sync', 'worker', 'scheduler', 'migrate', 'replicator'] as const;

export type Role = (typeof ROLES)[number];

export const DEFAULT_ROLE: Role = 'web';

/** What each role scales on — machine-readable, so `x deploy` can emit sane defaults. */
export type ScalingSignal =
  | 'rps'
  | 'ws-connections'
  | 'queue-depth'
  | 'singleton'
  | 'run-once'
  | 'per-database';

export interface RoleInfo {
  readonly role: Role;
  readonly scalesOn: ScalingSignal;
  /** Hard replica ceiling, when the role must not be scaled horizontally. */
  readonly maxReplicas: number | null;
  readonly stateful: boolean;
}

export const ROLE_INFO: Readonly<Record<Role, RoleInfo>> = Object.freeze({
  web: { role: 'web', scalesOn: 'rps', maxReplicas: null, stateful: false },
  sync: { role: 'sync', scalesOn: 'ws-connections', maxReplicas: null, stateful: false },
  worker: { role: 'worker', scalesOn: 'queue-depth', maxReplicas: null, stateful: false },
  scheduler: { role: 'scheduler', scalesOn: 'singleton', maxReplicas: 1, stateful: false },
  migrate: { role: 'migrate', scalesOn: 'run-once', maxReplicas: 1, stateful: false },
  replicator: { role: 'replicator', scalesOn: 'per-database', maxReplicas: 1, stateful: true },
});

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export interface ResolveRoleOptions {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly key?: string | undefined;
  readonly fallback?: Role | undefined;
}

/**
 * Read the role from the environment. Unset means `web` (the common case); a set-but-unknown
 * value is always a mistake and throws `X_ROLE_INVALID`.
 */
export function resolveRole(options?: ResolveRoleOptions): Role {
  const key = options?.key ?? 'ROLE';
  const source = options?.env ?? (process.env as Record<string, string | undefined>);
  const raw = source[key];
  if (raw === undefined || raw === '') return options?.fallback ?? DEFAULT_ROLE;
  if (!isRole(raw)) {
    throw new UltimateError({
      code: 'X_ROLE_INVALID',
      cause: `${key}="${raw}" is not one of ${ROLES.join(' | ')}`,
      fix: `set ${key} to one of: ${ROLES.join(', ')}`,
      meta: { key, received: raw, allowed: ROLES },
    });
  }
  return raw;
}
