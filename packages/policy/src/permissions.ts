// Permissions are `resource:verb` strings. Two layers of protection: the template
// literal type rejects a malformed string at compile time, and an app that augments
// `PermissionRegistry` (which `x g policy` does) turns a typo into a type error.
import { permissionUnknown } from './errors';

export type Permission = `${string}:${string}`;

/**
 * Augmented by the generated app code:
 *
 * ```ts
 * declare module '@ultimat3/policy' {
 *   interface PermissionRegistry { 'post:publish': true; 'post:read': true }
 * }
 * ```
 */
export interface PermissionRegistry {
  /** Phantom member; never augment or read this key. */
  readonly __ultimate?: never;
}

type Declared = Exclude<keyof PermissionRegistry, '__ultimate'>;

/** Every declared permission, or any `resource:verb` string before augmentation. */
export type KnownPermission = [Declared] extends [never]
  ? Permission
  : Extract<Declared, Permission>;

export interface PermissionSet<P extends Permission> {
  readonly all: readonly P[];
  has(value: string): value is P;
  /** Narrows a string to a declared permission, or throws `X_PERMISSION_UNKNOWN`. */
  assert(value: string): P;
  byResource(resource: string): readonly P[];
  resources(): readonly string[];
}

const declared = new Set<string>();

export const knownPermissions = (): readonly string[] => [...declared].sort();

/**
 * Runtime membership check. It stays silent until an app has declared its set,
 * because there is nothing to check against before then — `x verify` is what fails
 * a build that references a permission no `definePermissions()` call declares.
 */
export const isKnownPermission = (value: string): boolean =>
  declared.size === 0 || declared.has(value);

export const assertPermission = (value: string): string => {
  if (!isKnownPermission(value)) throw permissionUnknown(value, knownPermissions());
  return value;
};

export const resourceOf = (permission: string): string => permission.split(':')[0] ?? permission;

export const verbOf = (permission: string): string => permission.split(':')[1] ?? '';

export const definePermissions = <const P extends readonly Permission[]>(
  list: P,
): PermissionSet<P[number]> => {
  for (const permission of list) declared.add(permission);
  const all = [...list] as P[number][];
  return {
    all,
    has: (value): value is P[number] => all.includes(value as P[number]),
    assert: (value) => {
      if (!all.includes(value as P[number])) throw permissionUnknown(value, all);
      return value as P[number];
    },
    byResource: (resource) => all.filter((permission) => resourceOf(permission) === resource),
    resources: () => [...new Set(all.map(resourceOf))].sort(),
  };
};

/** Test seam; production never forgets a permission it declared. */
export const clearPermissions = (): void => declared.clear();
