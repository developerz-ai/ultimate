// The configs `claimAdminRoute` issued, each for the one path it was issued for. A leaf, read by
// `route-config.ts` (the mount's `claimable`) and written by `claim-route.ts` alone — never
// exported from the package: an app that could add a config here could put any route on an
// admin path, guard or none.

import type { RouteConfig } from '@ultimat3/render';

/** By IDENTITY: a spread copy of an issued config — a swapped `load` — is not issued. */
const issued = new WeakMap<object, string>();

export function issueClaim<TConfig extends object>(path: string, config: TConfig): TConfig {
  issued.set(config, path);
  return config;
}

/** May `config` serve `path` in the admin's place? Only if it was issued for exactly that path. */
export const claimable = (path: string, config: RouteConfig): boolean =>
  issued.get(config) === path;
