// The boot's disk never replaces a registry the app declared: `runtime.ts` imports app modules, and
// one calling `defineStorage({ disks: { uploads, evidence } })` has already run when the boot
// builds its own — whose one-disk `defineStorage` used to replace it (`X_STORAGE_DISK_UNKNOWN`).

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove; each boot's embedded root is a throwaway.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(); the throwaway root lives in the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import {
  definedStorage,
  defineStorage,
  memoryStorageDriver,
  resetStorage,
} from '@ultimat3/storage';
import type { DevServices } from './runtime-bindings';
import { startStorage } from './runtime-storage-boot';

const roots: string[] = [];

const embedded = (): DevServices => {
  const root = mkdtempSync(join(tmpdir(), 'x-storage-boot-'));
  roots.push(root);
  return {
    storage: { name: 'storage', mode: 'embedded', url: `file://${join(root, 'disk')}`, detail: '' },
    stateDir: root,
  } as unknown as DevServices;
};

const DEV = { ULTIMATE_ENV: 'development' };

afterEach(() => {
  resetStorage();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('unit · the boot keeps an app-declared storage', () => {
  test('an app registry declared before the boot keeps every disk', () => {
    const app = defineStorage({
      disks: { uploads: memoryStorageDriver(), evidence: memoryStorageDriver() },
      default: 'uploads',
    });
    const booted = startStorage(embedded(), DEV);
    expect(booted).toBe(app);
    expect(definedStorage()).toBe(app);
    expect(booted.diskNames).toEqual(['uploads', 'evidence']);
    expect(() => booted.disk('evidence')).not.toThrow();
  });

  test('and wins over runtime.ts`s one driver, as the port documents', () => {
    const app = defineStorage({ disks: { uploads: memoryStorageDriver() } });
    const booted = startStorage(embedded(), DEV, memoryStorageDriver());
    expect(booted).toBe(app);
    expect(definedStorage()?.diskNames).toEqual(['uploads']);
  });

  test('a registry an earlier boot in this process installed is its own, and is replaced', () => {
    const first = startStorage(embedded(), DEV);
    const second = startStorage(embedded(), DEV);
    expect(second).not.toBe(first);
    expect(definedStorage()).toBe(second);
  });

  test('with nothing declared, the boot installs its embedded disk', () => {
    const booted = startStorage(embedded(), DEV);
    expect(definedStorage()).toBe(booted);
    expect(booted.diskNames).toEqual(['local']);
  });
});
