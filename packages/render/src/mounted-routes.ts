/**
 * The routes a package MOUNTS — screens no surface file declares, like the admin's — held beside
 * the file routes so `registry.ts` can describe both in the one route list. Storage and the
 * collision rule only: nothing here renders, matches or serves.
 */

import { RouteDuplicateError } from './errors';
import type { RouteConfig } from './route';
import type { Surface } from './surfaces';

/** Who put a mounted route in the table, and what it requires. */
export interface RouteMount {
  /** The call that declared it: `defineAdmin`. */
  readonly by: string;
  /** Every permission the route's own screen decides on, coarse gate first. */
  readonly permissions: readonly string[];
  /**
   * `true` when an app FILE serves the path in the mount's place — a config the mounter issued
   * for it (`RouteMountInput.claimable`). The descriptor's `file` is then that file. Absent
   * otherwise, never `false`.
   */
  readonly claimed?: true;
}

/** The mount a set of routes belongs to. `key` is what a re-declaration replaces. */
export interface RouteMountInput {
  readonly key: string;
  readonly by: string;
  /** What `RouteDescriptor.file` reads for these routes: the package, since no app file is. */
  readonly file: string;
  readonly surface: Exclude<Surface, 'shared'>;
  /**
   * May the file route declaring `config` serve `path` in the mount's place? The MOUNTER's
   * answer, never render's: only the package that mounted a path knows which configs it issued
   * (and with what guard inside). Asked with the config the module EXPORTED, by identity. Absent:
   * no file may, and a file on a mounted path is `X_ROUTE_DUPLICATE`.
   */
  readonly claimable?: (path: string, config: RouteConfig) => boolean;
}

export interface MountedRouteInput {
  readonly path: string;
  readonly config: RouteConfig;
  readonly permissions: readonly string[];
}

export interface MountedRoute extends MountedRouteInput {
  readonly mount: RouteMountInput;
}

const mounted = new Map<string, readonly MountedRoute[]>();

/** Every mounted route, in mount-declaration order. */
export function mountedRoutes(): readonly MountedRoute[] {
  return [...mounted.values()].flat();
}

/** The mounted route claiming `path`, if one does. */
export function mountedAt(path: string): MountedRoute | undefined {
  return mountedRoutes().find((route) => route.path === path);
}

/** Replaces the set under `mount.key`: a re-declaration is the same mount, saved again. */
export function setMountedRoutes(
  mount: RouteMountInput,
  declared: readonly MountedRouteInput[],
): void {
  mounted.set(
    mount.key,
    declared.map((route) => ({ ...route, mount })),
  );
}

export function clearMountedRoutes(): void {
  mounted.clear();
}

/** Did the mount that owns `route` issue `config` for its path? */
export const claimedBy = (route: MountedRoute, config: RouteConfig): boolean =>
  route.mount.claimable?.(route.path, config) === true;

/** One URL, one claimant — a file and a mount on the same path is two servers for it. */
export const mountCollision = (
  path: string,
  file: string,
  mount: RouteMountInput,
): RouteDuplicateError =>
  new RouteDuplicateError(
    `${path} is claimed by both ${file} and ${mount.by}() — a route ${mount.file} mounts`,
    `delete ${file}: ${mount.by}() already serves ${path}, and the route table is keyed by URL`,
  );
