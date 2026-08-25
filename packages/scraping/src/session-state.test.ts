// A session is credential material: tenant-scoped, never logged, never an artifact. Three things
// are pinned here — the key is a tenant-first PATH, the digest is counts and an origin with no
// value in it, and a stored session that cannot be read is "no session" rather than a failed run.

import { describe, expect, test } from 'bun:test';
import type { StorageDriver, StorageObject } from '@ultimat3/storage';
import { cookieHeaderFor } from './cookie-scope';
import type { SessionState } from './session-state';
import {
  DEFAULT_SESSION_PREFIX,
  EMPTY_SESSION,
  memorySessionStore,
  parseSessionState,
  sessionDigest,
  sessionKeyFor,
  storageSessionStore,
} from './session-state';

const STATE: SessionState = {
  key: 'org-1/orders.daily/default',
  savedAt: '2026-01-01T00:00:00.000Z',
  cookies: [
    { name: 'sid', value: 's3cret', domain: 'shop.test', path: '/', httpOnly: true, secure: true },
  ],
  headers: { 'user-agent': 'agent' },
  storage: { token: 'bearer-abc' },
  userAgent: 'agent',
  origin: 'https://shop.test',
};

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
    writes,
    deletes,
    put(key, body, options) {
      writes.push({
        key,
        body: new TextDecoder().decode(body as Uint8Array),
        contentType: options?.contentType,
      });
      objects.set(key, new TextDecoder().decode(body as Uint8Array));
      return Promise.resolve(object(key));
    },
    get(key) {
      const found = objects.get(key);
      if (found === undefined) expect.unreachable(`no object at ${key}`);
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

describe('unit · sessionKeyFor', () => {
  test('the TENANT comes first, because the key is also an object-store prefix', () => {
    // A prefix that starts with the tenant is one a bucket policy can scope; scrape-first is not.
    const key = sessionKeyFor({ scrape: 'orders.daily', tenant: 'org-1' });
    expect(key.split('/')).toHaveLength(3);
    expect(key.startsWith('org-1.')).toBe(true);
  });

  test('no tenant is the literal "no-tenant", never an empty leading segment', () => {
    expect(sessionKeyFor({ scrape: 'orders.daily', tenant: undefined }).split('/')[0]).toBe(
      'no-tenant',
    );
  });

  test('the discriminator is a PART of the key, never the whole of it', () => {
    // `auth.key` supplies this. If it were the whole key, two tenants naming one account would
    // share one authenticated session.
    const key = sessionKeyFor({
      scrape: 'orders.daily',
      tenant: 'org-1',
      discriminator: 'ops@shop.test',
    });
    expect(key.startsWith('org-1.')).toBe(true);
    expect(key.split('/')[2]?.startsWith('ops-shop.test.')).toBe(true);
  });

  /**
   * THE property, and the one a `replaceAll` cannot hold: a run of characters outside
   * `[a-zA-Z0-9._-]` collapsed to a single `-`, so `alice@corp.com` and `alice-corp.com` were ONE
   * key. `restorableSession` loads by it, `driver.open({ restore })` puts account A's cookies and
   * `localStorage` into the browser, `auth.validate()` answers true — the session IS valid, for
   * the wrong account — and the scrape files A's rows under B's tenant.
   *
   * Traversal is NOT what the collapse was buying: `assertSafeKey` (`@ultimat3/storage`) already
   * refuses a `..` segment, and it still does, below.
   */
  test('two account names that differ only outside the safe alphabet are TWO keys', () => {
    const shape = { scrape: 'orders.daily', tenant: 'org-1' };
    const at = sessionKeyFor({ ...shape, discriminator: 'alice@corp.com' });
    const dash = sessionKeyFor({ ...shape, discriminator: 'alice-corp.com' });
    expect(at).not.toBe(dash);

    const slash = sessionKeyFor({ ...shape, discriminator: 'acct/1' });
    const hyphen = sessionKeyFor({ ...shape, discriminator: 'acct-1' });
    expect(slash).not.toBe(hyphen);
  });

  test('two TENANTS that differ only outside the safe alphabet are two key spaces', () => {
    const spaced = sessionKeyFor({ scrape: 'orders.daily', tenant: 'acme corp' });
    const hyphen = sessionKeyFor({ scrape: 'orders.daily', tenant: 'acme-corp' });
    expect(spaced).not.toBe(hyphen);
  });

  test('two SCRAPES that differ only outside the safe alphabet are two key spaces', () => {
    const spaced = sessionKeyFor({ scrape: 'orders daily', tenant: 'org-1' });
    const hyphen = sessionKeyFor({ scrape: 'orders-daily', tenant: 'org-1' });
    expect(spaced).not.toBe(hyphen);
  });

  test('a tenant named "no-tenant" is not the same key space as no tenant at all', () => {
    expect(sessionKeyFor({ scrape: 'orders.daily', tenant: 'no-tenant' })).not.toBe(
      sessionKeyFor({ scrape: 'orders.daily', tenant: undefined }),
    );
    expect(
      sessionKeyFor({ scrape: 'orders.daily', tenant: 'org-1', discriminator: 'default' }),
    ).not.toBe(sessionKeyFor({ scrape: 'orders.daily', tenant: 'org-1' }));
  });

  test('the same input answers the same key — a session store is a cache with a memory', () => {
    const input = { scrape: 'orders.daily', tenant: 'org-1', discriminator: 'ops@shop.test' };
    expect(sessionKeyFor(input)).toBe(sessionKeyFor(input));
  });

  test('every part stays inside the path alphabet, so the key is still a storage path', () => {
    const key = sessionKeyFor({
      scrape: 'orders daily',
      tenant: 'org 1',
      discriminator: 'a/b c\u0000',
    });
    expect(key.split('/')).toHaveLength(3);
    expect(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(key)).toBe(true);
  });
});

describe('unit · sessionDigest', () => {
  test('a log line gets counts and an origin — never a cookie value or a storage value', () => {
    const digest = sessionDigest(STATE);
    expect(digest).toEqual({
      session: 'present',
      origin: 'https://shop.test',
      cookies: 1,
      storageKeys: 1,
    });
    expect(JSON.stringify(digest)).not.toContain('s3cret');
    expect(JSON.stringify(digest)).not.toContain('bearer-abc');
  });

  test('no session is "none", not an object of zeroes that reads as an empty session', () => {
    expect(sessionDigest(undefined)).toEqual({ session: 'none' });
    expect(sessionDigest(EMPTY_SESSION)).toEqual({
      session: 'present',
      origin: '',
      cookies: 0,
      storageKeys: 0,
    });
  });
});

describe('unit · memorySessionStore', () => {
  test('it loads what it was seeded with, saves under the state`s own key, and burns', async () => {
    const store = memorySessionStore({ [STATE.key]: STATE });
    expect(await store.load(STATE.key)).toEqual(STATE);

    const other: SessionState = { ...STATE, key: 'org-2/orders.daily/default' };
    await store.save(other);
    expect(await store.load('org-2/orders.daily/default')).toEqual(other);

    await store.burn(STATE.key);
    expect(await store.load(STATE.key)).toBeUndefined();
  });
});

describe('unit · storageSessionStore', () => {
  test('a session round-trips through one JSON object under the default prefix', async () => {
    const storage = fakeStorage();
    const store = storageSessionStore(storage);

    await store.save(STATE);
    expect(storage.writes).toHaveLength(1);
    expect(storage.writes[0]?.key).toBe(`${DEFAULT_SESSION_PREFIX}/${STATE.key}.json`);
    expect(storage.writes[0]?.contentType).toBe('application/json');

    expect(await store.load(STATE.key)).toEqual(STATE);
  });

  test('the prefix is configurable and burn deletes the SAME path save wrote', async () => {
    const storage = fakeStorage();
    const store = storageSessionStore(storage, { prefix: 'sessions/v2' });
    await store.save(STATE);
    await store.burn(STATE.key);
    expect(storage.deletes).toEqual([`sessions/v2/${STATE.key}.json`]);
    expect(storage.writes[0]?.key).toBe(`sessions/v2/${STATE.key}.json`);
  });

  test('a session that is not there is undefined — reuse is the fast path, not the fragile one', async () => {
    // The driver THROWS on a missing key. Refusing the run over a cache miss would make every
    // first run of a scrape a failure.
    expect(
      await storageSessionStore(fakeStorage()).load('org-1/orders.daily/default'),
    ).toBeUndefined();
  });

  test('a corrupt record is undefined too, not a half-parsed session', async () => {
    const storage = fakeStorage({
      [`${DEFAULT_SESSION_PREFIX}/org-1/orders.daily/default.json`]: '{ not json',
    });
    expect(await storageSessionStore(storage).load('org-1/orders.daily/default')).toBeUndefined();
  });

  test('a key that would escape its prefix is refused, not written', async () => {
    // The key IS a storage path, so `assertSafeKey` is the backstop. It is still the backstop:
    // a hand-built key with a `..` segment is refused here.
    const storage = fakeStorage();
    await expect(
      storageSessionStore(storage).save({ ...STATE, key: 'org-1/../default' }),
    ).rejects.toThrow(/X_STORAGE_PATH_UNSAFE|".." segment/);
    expect(storage.writes).toEqual([]);
  });

  test('a scrape literally named ".." does not build a traversing key at all', async () => {
    // It used to: `sessionKeyFor({ scrape: '..' })` answered `org-1/../default`, and only
    // `assertSafeKey` stood between that and another tenant's object. The per-segment digest
    // means no segment can BE `..`, so the refusal below never has to fire.
    const storage = fakeStorage();
    const key = sessionKeyFor({ scrape: '..', tenant: 'org-1' });
    expect(key.split('/')[1]).not.toBe('..');
    await storageSessionStore(storage).save({ ...STATE, key });
    expect(storage.writes[0]?.key).toBe(`${DEFAULT_SESSION_PREFIX}/${key}.json`);
  });
});

describe('unit · parseSessionState', () => {
  test('the key comes from the CALLER, never from the stored bytes', () => {
    // The path the record was read from is the truth; a key inside the file could name another
    // tenant's session and would then be saved back over it.
    const parsed = parseSessionState({ ...STATE, key: 'org-9/other/default' }, 'org-1/a/default');
    expect(parsed?.key).toBe('org-1/a/default');
  });

  test('anything that is not an object with cookies and savedAt is undefined', () => {
    expect(parseSessionState(null, 'k')).toBeUndefined();
    expect(parseSessionState('a string', 'k')).toBeUndefined();
    expect(parseSessionState({ savedAt: '2026-01-01T00:00:00.000Z' }, 'k')).toBeUndefined();
    expect(parseSessionState({ cookies: [] }, 'k')).toBeUndefined();
    expect(parseSessionState({ cookies: {}, savedAt: 'x' }, 'k')).toBeUndefined();
  });

  test('an entry that is not a cookie is dropped, and the rest of the jar survives', () => {
    const parsed = parseSessionState(
      {
        savedAt: '2026-01-01T00:00:00.000Z',
        cookies: [
          { name: 'sid', value: 'abc' },
          { name: 'broken' },
          null,
          'sid=abc',
          { value: 'no name' },
        ],
      },
      'k',
    );
    expect(parsed?.cookies).toEqual([
      { name: 'sid', value: 'abc', domain: '', path: '/', httpOnly: false, secure: false },
    ]);
  });

  test('a cookie missing its scope is COMPLETED, never smuggled through as half a ScrapeCookie', () => {
    // `isCookie` asserted `value is ScrapeCookie` while checking two of that type's six required
    // fields, so a stored `{ name, value }` left this function typed as a whole cookie with no
    // `domain` — and `cookieDomainMatches`, reached from the public `cookieHeaderFor`, calls
    // `.trim()` on it. Completing the record is what makes the declared type true.
    const parsed = parseSessionState(
      { savedAt: '2026-01-01T00:00:00.000Z', cookies: [{ name: 'sid', value: 'abc' }] },
      'k',
    );
    expect(parsed?.cookies).toEqual([
      { name: 'sid', value: 'abc', domain: '', path: '/', httpOnly: false, secure: false },
    ]);
    // And what makes the completion SAFE rather than a guess: an unscoped cookie reaches no host.
    // `cookiesForUrl` fails closed on an empty domain, so the default cannot widen a jar — the
    // alternative, inferring the domain from whichever URL asked, is how a `bank.test` session
    // cookie ends up on `evilbank.test`.
    expect(cookieHeaderFor(parsed?.cookies ?? [], 'https://bank.test/')).toBeUndefined();
  });

  test('the missing halves default rather than making the record unreadable', () => {
    const parsed = parseSessionState({ savedAt: '2026-01-01T00:00:00.000Z', cookies: [] }, 'k');
    expect(parsed).toEqual({
      key: 'k',
      savedAt: '2026-01-01T00:00:00.000Z',
      cookies: [],
      headers: {},
      storage: {},
      userAgent: '',
      origin: '',
    });
    expect(Object.hasOwn(parsed as object, 'refusedAt')).toBe(false);
  });

  test('a refusal tombstone survives the round trip — it is what makes a replay cheap', () => {
    const parsed = parseSessionState(
      { savedAt: '2026-01-01T00:00:00.000Z', cookies: [], refusedAt: '2026-01-02T00:00:00.000Z' },
      'k',
    );
    expect(parsed?.refusedAt).toBe('2026-01-02T00:00:00.000Z');
    // Anything that is not an ISO string is not a tombstone: a truthy 1 must not refuse a run.
    const bogus = parseSessionState(
      { savedAt: '2026-01-01T00:00:00.000Z', cookies: [], refusedAt: 1 },
      'k',
    );
    expect(Object.hasOwn(bogus as object, 'refusedAt')).toBe(false);
  });
});
