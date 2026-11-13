// The role fixture's reset gives back the storage registry the fixture installed — and only that
// one. A registry left standing is a later file's "app-declared" storage (`startStorage` keeps any
// registry it did not install), so the leak showed up as a `local` disk where `memory` was asked.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp directory or recursive delete of its own.
import { mkdtemp, rm } from 'node:fs/promises';
// why: as above — the platform temp root is only node:os's to name.
import { tmpdir } from 'node:os';
import {
  definedStorage,
  defineStorage,
  memoryStorageDriver,
  resetStorage,
} from '@ultimat3/storage';
import { fixtureRuntime, resetDevRolesState } from './role-start-fixture';

/** The fixture resolves a state directory under its root, so the root must be one it can write. */
const ROOT = await mkdtemp(`${tmpdir()}/role-start-fixture-`);

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

afterEach(() => {
  resetStorage();
});

describe('resetDevRolesState and the storage registry', () => {
  test('drops the registry fixtureRuntime installed', () => {
    const runtime = fixtureRuntime(ROOT);
    expect(definedStorage()).toBe(runtime.storage);
    resetDevRolesState();
    expect(definedStorage()).toBeUndefined();
  });

  test('keeps a registry a test declared after the fixture: it is not the fixture’s to drop', () => {
    fixtureRuntime(ROOT);
    const own = defineStorage({ disks: { memory: memoryStorageDriver() } });
    resetDevRolesState();
    expect(definedStorage()).toBe(own);
  });

  test('keeps a registry declared with no fixture at all', () => {
    const own = defineStorage({ disks: { memory: memoryStorageDriver() } });
    resetDevRolesState();
    expect(definedStorage()).toBe(own);
  });
});
