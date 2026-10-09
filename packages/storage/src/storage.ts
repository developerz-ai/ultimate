// Single responsibility: named disks (Laravel's model) and the one module-level accessor.
// Call sites name a disk, never a driver — swapping `local` for `s3` in app.config.ts must
// not touch a single `storage.disk('uploads').put(...)` call. This file is also where a driver
// LEARNS its disk name (`registerAs`), because the registry is the only holder of that fact and
// a signed URL's `:disk` segment has to be the name the mounted route resolves.

import { ConfigInvalidError } from '@ultimat3/core';
import type { StorageDriver } from './driver';
import { diskUnknown } from './errors';
import { isSafeKey, isTenantScoped } from './path';

export interface StorageConfig {
  readonly disks: Readonly<Record<string, StorageDriver>>;
  /** Disk used when `disk()` is called with no name. Defaults to the first declared disk. */
  readonly default?: string | undefined;
  /**
   * Key prefixes, per disk, that hold objects NO tenant owns and every reader may have — a brand
   * logo, a shared asset. The only way a key outside `org/<id>/` is served by `/_storage` and
   * `/media` (still to a signed-in actor holding `storage:read`); everything else outside a
   * tenant prefix — exports, raw payloads, DSR archives — is refused `X_STORAGE_KEY_UNSHARED`.
   * Each prefix ends in `/` and names a whole segment: `{ uploads: ['brand/'] }`.
   */
  readonly shared?: Readonly<Record<string, readonly string[]>> | undefined;
}

export interface Storage {
  readonly defaultDisk: string;
  readonly diskNames: readonly string[];
  disk(name?: string): StorageDriver;
  /**
   * Whether `key` on `disk` lies under a prefix `StorageConfig.shared` declared for that disk. A
   * tenant-scoped key is never shared, and an unknown disk shares nothing.
   */
  isShared(disk: string, key: string): boolean;
}

/**
 * The declared prefixes, refused at boot when one could never mean what it says: a disk that is
 * not declared, a prefix that is not a whole segment, one that would share the whole disk, or one
 * inside the tenant namespace — sharing `org/` would undo the boundary the prefix exists beside.
 */
function sharedPrefixes(
  shared: StorageConfig['shared'],
  names: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const [diskName, prefixes] of Object.entries(shared ?? {})) {
    if (!names.includes(diskName)) {
      throw new ConfigInvalidError({
        cause: `storage.shared names disk "${diskName}" but the configured disks are: ${names.join(', ')}`,
        fix: `defineStorage({ disks, shared: { ${names[0] ?? '<disk>'}: ['<prefix>/'] } })   # key it by one of: ${names.join(', ')}`,
      });
    }
    for (const prefix of prefixes) {
      const shareable =
        typeof prefix === 'string' &&
        prefix.endsWith('/') &&
        isSafeKey(prefix.slice(0, -1)) &&
        !isTenantScoped(prefix);
      if (!shareable) {
        throw new ConfigInvalidError({
          cause: `storage.shared.${diskName} lists ${JSON.stringify(prefix)}, which is not a shareable prefix: it must be a relative key ending in "/" and outside "org/"`,
          fix: `defineStorage({ disks, shared: { ${diskName}: ['brand/'] } })   # whole segments ending in "/", outside org/ — a tenant's object is read by its own org, never shared`,
        });
      }
    }
    out.set(diskName, Object.freeze([...prefixes]));
  }
  return out;
}

let current: Storage | undefined;

/**
 * Build the disk map and install it as the process-wide storage. There is exactly one, the
 * same way there is exactly one `app.config.ts` — a second registry is a second source of truth.
 */
export function defineStorage(config: StorageConfig): Storage {
  const names = Object.keys(config.disks);
  if (names.length === 0) {
    throw new ConfigInvalidError({
      cause: 'defineStorage() was called with no disks',
      fix: "add a disk: defineStorage({ disks: { local: localDriver({ root: '.storage' }) } })",
    });
  }
  const first = names[0] ?? '';
  const defaultDisk = config.default ?? first;
  if (!names.includes(defaultDisk)) {
    throw new ConfigInvalidError({
      cause: `storage.default is "${defaultDisk}" but the configured disks are: ${names.join(', ')}`,
      fix: `set storage.default to one of: ${names.join(', ')} in app.config.ts`,
    });
  }
  // A Map, and the SAME own-keys read `names` above is built from. `config.disks[wanted]` walked
  // the prototype chain, so `disk('constructor')` answered with the `Object` function and the next
  // `.put()` was a bare `TypeError` inside app code — `diskUnknown` unreachable for `constructor`,
  // `toString`, `valueOf`, `hasOwnProperty` and `__proto__`. One function was already answering
  // one question two ways: `default: 'constructor'` is refused above, off `Object.keys`.
  const disks = new Map(Object.entries(config.disks));
  // One driver instance, one disk name. A driver told two names keeps the last, and every URL it
  // minted under the first then resolves to a disk it is not — refused here rather than 404ing
  // one alias at a time. Two disks over one root are two `localDriver()` calls.
  const registered = new Map<StorageDriver, string>();
  for (const [diskName, driver] of disks) {
    const already = registered.get(driver);
    if (already !== undefined) {
      throw new ConfigInvalidError({
        cause: `storage disks "${already}" and "${diskName}" are the same driver instance, and a driver can only mint URLs under one name`,
        fix: `give "${diskName}" its own driver in app.config.ts: disks: { ${already}: localDriver({ root: '.storage/${already}' }), ${diskName}: localDriver({ root: '.storage/${diskName}' }) }`,
      });
    }
    registered.set(driver, diskName);
    driver.registerAs?.(diskName);
  }
  const shared = sharedPrefixes(config.shared, names);
  const storageInstance: Storage = {
    defaultDisk,
    diskNames: Object.freeze([...names]),
    disk(name?: string): StorageDriver {
      const wanted = name ?? defaultDisk;
      const driver = disks.get(wanted);
      if (driver === undefined) throw diskUnknown(wanted, names);
      return driver;
    },
    isShared(diskName: string, key: string): boolean {
      if (!isSafeKey(key) || isTenantScoped(key)) return false;
      return (shared.get(diskName) ?? []).some((prefix) => key.startsWith(prefix));
    },
  };
  current = storageInstance;
  return storageInstance;
}

/** The configured storage. Throws rather than lazily inventing a disk behind your back. */
export function storage(): Storage {
  if (current === undefined) {
    throw new ConfigInvalidError({
      cause: 'storage() was called before defineStorage()',
      fix: "call defineStorage({ disks: { local: localDriver({ root: '.storage' }) } }) in app.config.ts",
    });
  }
  return current;
}

/**
 * The configured storage, or `undefined` before any `defineStorage` — the question a host asks
 * when it must serve whatever the app installed and fall back to its own disk otherwise. The LAST
 * call wins, by `defineStorage`'s own contract: there is one registry, so the app's declaration
 * replaces a host's default rather than sitting beside it.
 */
export function definedStorage(): Storage | undefined {
  return current;
}

/** Shorthand for the common call. `disk()` alone resolves the default disk. */
export function disk(name?: string): StorageDriver {
  return storage().disk(name);
}

/** Test seam: drop the module-level storage so the next test defines its own. */
export function resetStorage(): void {
  current = undefined;
}
