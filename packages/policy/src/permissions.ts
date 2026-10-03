// Permissions are `resource:verb` strings. Two layers of protection: the template
// literal type rejects a malformed string at compile time, and an app that augments
// `PermissionRegistry` (which `x g policy` does) turns a typo into a type error.
import { callerSite } from './declaration-site';
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
/** Every distinct module that declared each name — a `Map`, because a name is caller data. */
const sites = new Map<string, Set<string>>();

export const knownPermissions = (): readonly string[] => [...declared].sort();

/**
 * Where each permission was declared: one stack frame per distinct declaring call, as
 * `roleDeclarationSites()` answers for roles. ALL of them rather than the first, because the
 * question asked of it is provenance — the `policy` step flags an app rule that holds only because
 * a package it imports (`@ultimat3/admin`'s `defineAdmin()`) declared the name, and an app that
 * declares the same name itself is then not leaning on anything.
 */
export const permissionDeclarationSites = (): Readonly<Record<string, readonly string[]>> =>
  Object.fromEntries([...sites].map(([name, at]) => [name, [...at]]));

const recordSite = (permission: string, site: string): void => {
  const at = sites.get(permission);
  if (at === undefined) sites.set(permission, new Set([site]));
  else at.add(site);
};

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
  const site = callerSite();
  for (const permission of list) {
    declared.add(permission);
    recordSite(permission, site);
  }
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
export const clearPermissions = (): void => {
  declared.clear();
  sites.clear();
};

/**
 * `clearPermissions()`'s other half, taking exactly what `knownPermissions()` answers.
 *
 * `definePermissions()` runs at MODULE scope — `@ultimat3/admin` declares `admin:*` on its
 * barrel's import — and a module evaluates once per `bun test` process. So a clear in one test
 * file is permanent for every file after it: that file's own `import` is a cache hit which
 * registers nothing, and `can('admin:read')` throws X_PERMISSION_UNKNOWN for a permission the
 * process really did declare. Only putting the captured set back repairs it; re-importing cannot.
 * Replaces rather than merges — a capture is the whole truth about the process, not an addition.
 *
 * `declaredAt` is what `permissionDeclarationSites()` answered, and the same rule `restoreRoles`
 * states: re-declaring through `definePermissions` would name THIS frame as every permission's
 * origin. REQUIRED, never defaulted: an omitted argument restored every name with no site, and a
 * name with no site is one the policy step cannot judge — so a forgotten argument silently turned
 * `X_PERMISSION_BORROWED` off for the rest of the process. `{}` says "no provenance" on purpose.
 */
export const restorePermissions = (
  permissions: readonly string[],
  declaredAt: Readonly<Record<string, readonly string[]>>,
): void => {
  declared.clear();
  sites.clear();
  for (const permission of permissions) {
    declared.add(permission);
    const at = Object.hasOwn(declaredAt, permission) ? declaredAt[permission] : undefined;
    for (const site of at ?? []) recordSite(permission, site);
  }
};
