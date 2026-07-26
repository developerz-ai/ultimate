// Single responsibility: named disks (Laravel's model) and the one module-level accessor.
// Call sites name a disk, never a driver — swapping `local` for `s3` in app.config.ts must
// not touch a single `storage.disk('uploads').put(...)` call.

import { ConfigInvalidError } from '@ultimat3/core';
import type { StorageDriver } from './driver';
import { diskUnknown } from './errors';

export interface StorageConfig {
  readonly disks: Readonly<Record<string, StorageDriver>>;
  /** Disk used when `disk()` is called with no name. Defaults to the first declared disk. */
  readonly default?: string | undefined;
}

export interface Storage {
  readonly defaultDisk: string;
  readonly diskNames: readonly string[];
  disk(name?: string): StorageDriver;
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
  const storageInstance: Storage = {
    defaultDisk,
    diskNames: Object.freeze([...names]),
    disk(name?: string): StorageDriver {
      const wanted = name ?? defaultDisk;
      const driver = config.disks[wanted];
      if (driver === undefined) throw diskUnknown(wanted, names);
      return driver;
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

/** Shorthand for the common call. `disk()` alone resolves the default disk. */
export function disk(name?: string): StorageDriver {
  return storage().disk(name);
}

/** Test seam: drop the module-level storage so the next test defines its own. */
export function resetStorage(): void {
  current = undefined;
}
