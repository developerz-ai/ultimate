// What `storageSessionStore` puts in the bucket, and what it refuses to read back. A stored session
// is an authenticated identity, so the object holds a sealed string and nothing else; anything
// found there that is not this store's own sealed record is burned and the run logs in again.

import { describe, expect, test } from 'bun:test';
import { isSealed, seal } from '@ultimat3/core';
import type { StorageDriver, StorageObject } from '@ultimat3/storage';
import type { SessionState } from './session-state';
import {
  DEFAULT_SESSION_PREFIX,
  SESSION_SEAL_PURPOSE,
  sessionKeyFor,
  storageSessionStore,
} from './session-state';

/** Throwaway master keys, handed to the store through `seal()`'s own `env` seam. */
const KEYS = { env: { ULTIMATE_SECRETS_KEY: 'a1'.repeat(32) }, root: '/nonexistent-app-root' };
const OTHER_KEYS = {
  env: { ULTIMATE_SECRETS_KEY: 'b2'.repeat(32) },
  root: '/nonexistent-app-root',
};
const NO_KEYS = { env: {}, root: '/nonexistent-app-root' };

const STATE: SessionState = {
  key: 'org-1/orders.daily/default',
  savedAt: '2026-01-01T00:00:00.000Z',
  cookies: [
    {
      name: 'sid',
      value: 's3cret-cookie-value',
      domain: 'shop.test',
      path: '/',
      httpOnly: true,
      secure: true,
    },
  ],
  headers: { 'user-agent': 'agent' },
  storage: { token: 'bearer-abc-123' },
  userAgent: 'agent',
  origin: 'https://shop.test',
};

const PATH = `${DEFAULT_SESSION_PREFIX}/${STATE.key}.json`;

const object = (key: string): StorageObject => ({
  key,
  size: 0,
  contentType: 'application/json',
  etag: 'e',
  lastModified: new Date(0),
});

/**
 * Only the three methods this store uses. Everything else throws rather than answering something
 * plausible: a fake that quietly returned `[]` from `list()` would let a store that started
 * listing objects read as covered.
 */
function fakeStorage(seed: Readonly<Record<string, string>> = {}): StorageDriver & {
  readonly objects: Map<string, string>;
  readonly writes: { key: string; body: string; contentType: string | undefined }[];
  readonly deletes: string[];
} {
  const objects = new Map(Object.entries(seed));
  const writes: { key: string; body: string; contentType: string | undefined }[] = [];
  const deletes: string[] = [];
  const unsupported = (what: string) => (): never => {
    throw new Error(`this fake storage driver does not implement ${what}`);
  };
  return {
    name: 'fake',
    objects,
    writes,
    deletes,
    put(key, body, options) {
      const text = new TextDecoder().decode(body as Uint8Array);
      writes.push({ key, body: text, contentType: options?.contentType });
      objects.set(key, text);
      return Promise.resolve(object(key));
    },
    get(key) {
      const found = objects.get(key);
      // INPUT to the store, the way a real driver answers a missing key: it rejects.
      if (found === undefined) return Promise.reject(new Error(`no object at ${key}`));
      return Promise.resolve({ object: object(key), bytes: new TextEncoder().encode(found) });
    },
    delete(key) {
      deletes.push(key);
      objects.delete(key);
      return Promise.resolve();
    },
    stream: unsupported('stream'),
    copy: unsupported('copy'),
    exists: unsupported('exists'),
    list: unsupported('list'),
    signedUrl: unsupported('signedUrl'),
  };
}

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (thrown) {
    return (thrown as { code?: string }).code;
  }
};

describe('unit · a stored session is sealed at rest', () => {
  test('the stored bytes carry no cookie value, no storage token and no origin', async () => {
    const storage = fakeStorage();
    await storageSessionStore(() => storage, { keySource: KEYS }).save(STATE);
    const body = storage.writes[0]?.body ?? '';
    expect(body).not.toContain('s3cret-cookie-value');
    expect(body).not.toContain('bearer-abc-123');
    expect(body).not.toContain('shop.test');
    expect(body).not.toContain('sid');
  });

  test('the object is one JSON document holding one sealed string, under the same path', async () => {
    const storage = fakeStorage();
    await storageSessionStore(() => storage, { keySource: KEYS }).save(STATE);
    expect(storage.writes).toHaveLength(1);
    expect(storage.writes[0]?.key).toBe(PATH);
    expect(storage.writes[0]?.contentType).toBe('application/json');
    const stored = JSON.parse(storage.writes[0]?.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(stored)).toEqual(['sealed']);
    expect(isSealed(stored['sealed'])).toBe(true);
  });

  test('a session round-trips through the seal', async () => {
    const storage = fakeStorage();
    const store = storageSessionStore(() => storage, { keySource: KEYS });
    await store.save(STATE);
    expect(await store.load(STATE.key)).toEqual(STATE);
    expect(storage.deletes).toEqual([]);
  });

  test('the refusal tombstone is sealed and read back like any record', async () => {
    const storage = fakeStorage();
    const store = storageSessionStore(() => storage, { keySource: KEYS });
    await store.save({ ...STATE, cookies: [], refusedAt: '2026-01-02T00:00:00.000Z' });
    expect(storage.writes[0]?.body).not.toContain('refusedAt');
    expect((await store.load(STATE.key))?.refusedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  test('the prefix is configurable and burn deletes the SAME path save wrote', async () => {
    const storage = fakeStorage();
    const store = storageSessionStore(() => storage, { prefix: 'sessions/v2', keySource: KEYS });
    await store.save(STATE);
    await store.burn(STATE.key);
    expect(storage.deletes).toEqual([`sessions/v2/${STATE.key}.json`]);
    expect(storage.writes[0]?.key).toBe(`sessions/v2/${STATE.key}.json`);
  });
});

describe('unit · what is found in the bucket and is not this store`s sealed record is burned', () => {
  test('an UNSEALED session — the shape before sealing — is burned, never restored', async () => {
    const storage = fakeStorage({ [PATH]: JSON.stringify(STATE) });
    expect(
      await storageSessionStore(() => storage, { keySource: KEYS }).load(STATE.key),
    ).toBeUndefined();
    expect(storage.deletes).toEqual([PATH]);
    expect(storage.objects.has(PATH)).toBe(false);
  });

  test('a corrupt object is burned too, not half-parsed', async () => {
    const storage = fakeStorage({ [PATH]: '{ not json' });
    expect(
      await storageSessionStore(() => storage, { keySource: KEYS }).load(STATE.key),
    ).toBeUndefined();
    expect(storage.deletes).toEqual([PATH]);
  });

  test('a record sealed under a key this process does not declare is burned', async () => {
    const storage = fakeStorage();
    await storageSessionStore(() => storage, { keySource: OTHER_KEYS }).save(STATE);
    expect(
      await storageSessionStore(() => storage, { keySource: KEYS }).load(STATE.key),
    ).toBeUndefined();
    expect(storage.deletes).toEqual([PATH]);
  });

  test('a value sealed for another purpose does not open as a session', async () => {
    const sealed = await seal(JSON.stringify(STATE), { purpose: 'entity:users.notes', ...KEYS });
    const storage = fakeStorage({ [PATH]: JSON.stringify({ sealed }) });
    expect(
      await storageSessionStore(() => storage, { keySource: KEYS }).load(STATE.key),
    ).toBeUndefined();
    expect(storage.deletes).toEqual([PATH]);
  });

  test('a sealed record copied onto ANOTHER key`s path is not that key`s session', async () => {
    // What someone with write access to the bucket can do without the master key: move org-1's
    // object to org-2's path. It opens — the seal is valid — and it is still org-1's identity.
    const storage = fakeStorage();
    const store = storageSessionStore(() => storage, { keySource: KEYS });
    await store.save(STATE);
    const theirs = 'org-2/orders.daily/default';
    const theirPath = `${DEFAULT_SESSION_PREFIX}/${theirs}.json`;
    storage.objects.set(theirPath, storage.objects.get(PATH) ?? '');
    expect(await store.load(theirs)).toBeUndefined();
    expect(storage.deletes).toEqual([theirPath]);
  });

  test('a session that is not there is undefined and deletes nothing — the first run of a scrape', async () => {
    const storage = fakeStorage();
    expect(
      await storageSessionStore(() => storage, { keySource: KEYS }).load(STATE.key),
    ).toBeUndefined();
    expect(storage.deletes).toEqual([]);
  });

  test('a delete that fails does not fail the load — the next load refuses the object again', async () => {
    const storage = fakeStorage({ [PATH]: JSON.stringify(STATE) });
    const failing: StorageDriver = {
      ...storage,
      delete: () => Promise.reject(new Error('s3: 503 slow down')),
    };
    expect(
      await storageSessionStore(() => failing, { keySource: KEYS }).load(STATE.key),
    ).toBeUndefined();
  });
});

describe('unit · no master key is a refusal BEFORE the browser opens, never "no session"', () => {
  test('load() rejects X_SEAL_KEY_MISSING even when nothing is stored', async () => {
    const storage = fakeStorage();
    expect(
      await codeOf(storageSessionStore(() => storage, { keySource: NO_KEYS }).load(STATE.key)),
    ).toBe('X_SEAL_KEY_MISSING');
  });

  test('save() rejects too, and writes nothing — never the plaintext in its place', async () => {
    const storage = fakeStorage();
    expect(
      await codeOf(storageSessionStore(() => storage, { keySource: NO_KEYS }).save(STATE)),
    ).toBe('X_SEAL_KEY_MISSING');
    expect(storage.writes).toEqual([]);
  });
});

describe('unit · the key is still a storage path', () => {
  test('a key that would escape its prefix is refused, not written', async () => {
    const storage = fakeStorage();
    await expect(
      storageSessionStore(() => storage, { keySource: KEYS }).save({
        ...STATE,
        key: 'org-1/../default',
      }),
    ).rejects.toThrow(/X_STORAGE_PATH_UNSAFE|".." segment/);
    expect(storage.writes).toEqual([]);
  });

  test('a scrape literally named ".." does not build a traversing key at all', async () => {
    const storage = fakeStorage();
    const key = sessionKeyFor({ scrape: '..', tenant: 'org-1' });
    expect(key.split('/')[1]).not.toBe('..');
    await storageSessionStore(() => storage, { keySource: KEYS }).save({ ...STATE, key });
    expect(storage.writes[0]?.key).toBe(`${DEFAULT_SESSION_PREFIX}/${key}.json`);
  });

  test('the purpose is the documented constant', () => {
    expect(SESSION_SEAL_PURPOSE).toBe('scrape-session');
  });
});
