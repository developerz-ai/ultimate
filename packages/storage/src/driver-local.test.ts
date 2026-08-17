import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { frozenClock } from '@ultimat3/core';
import type { StorageDriver } from './driver';
import {
  DEV_SIGNING_SECRET,
  localDriver,
  STORAGE_SIGNING_SECRET_KEY,
  usesDevStorageSecret,
} from './driver-local';
import { isStorageError, type StorageError } from './errors';
import { META_DIR, scopedKey } from './path';

let root = '';
let driver: StorageDriver;

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** The error code a driver call answered with, or how it failed to answer with one. */
async function catchCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return isStorageError(error) ? error.code : `not-a-storage-error: ${String(error)}`;
  }
  return 'no-throw';
}

/** The thrown value itself, where the assertion is about its `cause`/`fix` and not just its code. */
async function catchError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

const codeOf = (caught: unknown): string =>
  isStorageError(caught) ? caught.code : `not-a-storage-error: ${String(caught)}`;

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/ultimate-storage-`);
  driver = localDriver({
    root,
    signingSecret: 'test-secret',
    clock: frozenClock('2026-07-26T12:00:00.000Z'),
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('localDriver', () => {
  test('round-trips put -> exists -> get -> list -> delete with the content type', async () => {
    const key = 'org/org-1/avatars/a.png';
    const put = await driver.put(key, bytesOf('pretend-png'), { contentType: 'image/png' });
    expect(put.key).toBe(key);
    expect(put.size).toBe(11);
    expect(put.contentType).toBe('image/png');
    expect(put.etag.length).toBe(32);

    expect(await driver.exists(key)).toBe(true);

    const read = await driver.get(key);
    expect(textOf(read.bytes)).toBe('pretend-png');
    // The sidecar exists precisely so this survives a process restart.
    expect(read.object.contentType).toBe('image/png');
    expect(read.object.etag).toBe(put.etag);
    expect(read.object.size).toBe(11);

    const page = await driver.list({ prefix: 'org/org-1/' });
    expect(page.objects.map((object) => object.key)).toEqual([key]);
    expect(page.truncated).toBe(false);
    // The `.meta` sidecar tree must never appear as an object.
    expect(page.objects.every((object) => !object.key.startsWith('.meta/'))).toBe(true);

    await driver.delete(key);
    expect(await driver.exists(key)).toBe(false);
    expect((await driver.list({ prefix: 'org/org-1/' })).objects).toEqual([]);
  });

  test('get and list round-trip cacheControl and metadata written by put()', async () => {
    const key = 'org/org-1/docs/report.pdf';
    await driver.put(key, bytesOf('pdf-bytes'), {
      contentType: 'application/pdf',
      cacheControl: 'public, max-age=3600',
      metadata: { uploadedBy: 'user-1' },
    });

    const read = await driver.get(key);
    expect(read.object.cacheControl).toBe('public, max-age=3600');
    expect(read.object.metadata).toEqual({ uploadedBy: 'user-1' });

    const [listed] = (await driver.list({ prefix: 'org/org-1/' })).objects;
    expect(listed?.cacheControl).toBe('public, max-age=3600');
    expect(listed?.metadata).toEqual({ uploadedBy: 'user-1' });
  });

  // `typeof [] === 'object'` and `Object.values(['a']).every(isString)` is `true`, so an ARRAY in
  // the sidecar's `metadata` slot was handed back through `head()`/`get()` as object metadata —
  // and `StorageObject.metadata` is declared `Record<string, string>`, so every reader downstream
  // was typed against a shape it was not given.
  test('an array in the sidecar metadata slot is not object metadata', async () => {
    const key = 'org/org-1/docs/odd.pdf';
    await driver.put(key, bytesOf('pdf-bytes'), { contentType: 'application/pdf' });

    const sidecar = `${root}/${META_DIR}/${key}.json`;
    const written: unknown = await Bun.file(sidecar).json();
    await Bun.write(
      sidecar,
      JSON.stringify({ ...(written as Record<string, unknown>), metadata: ['a', 'b'] }),
    );

    expect((await driver.get(key)).object.metadata).toBeUndefined();
    const [listed] = (await driver.list({ prefix: 'org/org-1/' })).objects;
    expect(listed?.metadata).toBeUndefined();
  });

  test('get on a missing key is X_STORAGE_NOT_FOUND', async () => {
    let caught: unknown;
    try {
      await driver.get('org/org-1/missing.png');
    } catch (error) {
      caught = error;
    }
    expect(isStorageError(caught)).toBe(true);
    expect(isStorageError(caught) ? caught.code : '').toBe('X_STORAGE_NOT_FOUND');
  });

  test('delete is idempotent for an ABSENT key', async () => {
    await driver.delete('org/org-1/never-existed.png');
    expect(await driver.exists('org/org-1/never-existed.png')).toBe(false);
  });

  test('delete SURFACES a refused unlink as X_STORAGE_DELETE_FAILED', async () => {
    // The failure that matters: `.catch(() => undefined)` reported a read-only mount, a denied
    // unlink and an absent key identically, so a sweep certified bytes erased that were not.
    // A directory in the object's place is the cheapest unlink the OS refuses with something
    // other than ENOENT (EISDIR/EPERM), and it needs no root and no chmod dance.
    const key = 'org/org-1/undeletable';
    await Bun.write(`${root}/${key}/child.txt`, 'blocked');

    const caught = await catchError(() => driver.delete(key));
    expect(codeOf(caught)).toBe('X_STORAGE_DELETE_FAILED');
    const error = caught as StorageError;
    expect(error.cause).toContain('undeletable');
    expect(error.fix).toContain(`ls -ld ${root}`);
    expect(await Bun.file(`${root}/${key}/child.txt`).exists()).toBe(true);
  });

  test('put refuses a body over the ceiling before writing anything', async () => {
    const bounded = localDriver({ root, signingSecret: 'test-secret', maxPutBytes: 4 });
    const caught = await catchError(() => bounded.put('org/org-1/big.bin', bytesOf('12345')));
    expect(codeOf(caught)).toBe('X_STORAGE_TOO_LARGE');
    const error = caught as StorageError;
    expect(error.fix).toContain('grantUpload');
    expect(error.fix).toContain('localDriver({ root, maxPutBytes: 5 })');
    expect(await Bun.file(`${root}/org/org-1/big.bin`).exists()).toBe(false);
  });

  test('put refuses server-side encryption rather than pretending a plain file has it', async () => {
    const caught = await catchError(() =>
      driver.put('org/org-1/s.txt', bytesOf('x'), {
        serverSideEncryption: { algorithm: 'AES256' },
      }),
    );
    expect(codeOf(caught)).toBe('X_NOT_IMPLEMENTED');
    // Both drivers refuse: a put that works in dev and throws in production is two rules.
    expect(await Bun.file(`${root}/org/org-1/s.txt`).exists()).toBe(false);
  });

  describe('copy', () => {
    test('duplicates bytes and the sidecar, and leaves the source alone', async () => {
      const from = 'org/org-1/from.png';
      const to = 'org/org-1/to.png';
      await driver.put(from, bytesOf('pixels'), {
        contentType: 'image/png',
        cacheControl: 'public, max-age=60',
      });

      const copied = await driver.copy(from, to);
      expect(copied.key).toBe(to);
      expect(copied.contentType).toBe('image/png');
      expect(copied.cacheControl).toBe('public, max-age=60');
      // The sidecar travelled too, so the copy survives a restart with its real content type.
      const read = await driver.get(to);
      expect(textOf(read.bytes)).toBe('pixels');
      expect(read.object.contentType).toBe('image/png');
      expect(await driver.exists(from)).toBe(true);
    });

    test('a missing source is X_STORAGE_NOT_FOUND and writes no destination', async () => {
      expect(await catchCode(() => driver.copy('org/org-1/nope.png', 'org/org-1/to.png'))).toBe(
        'X_STORAGE_NOT_FOUND',
      );
      expect(await driver.exists('org/org-1/to.png')).toBe(false);
    });

    test('both arguments go through assertSafeKey', async () => {
      expect(await catchCode(() => driver.copy('../x', 'org/org-1/to.png'))).toBe(
        'X_STORAGE_PATH_UNSAFE',
      );
      expect(await catchCode(() => driver.copy('org/org-1/from.png', '../x'))).toBe(
        'X_STORAGE_PATH_UNSAFE',
      );
    });
  });

  test('list omits contentType when no sidecar knows it, rather than inventing one', async () => {
    // A file written around the driver — a restored backup, a `cp` into the root — has no
    // sidecar. Reporting `application/octet-stream` for it is the same fabrication the s3
    // driver's listing used to make; absent says "this listing does not know".
    await Bun.write(`${root}/org/org-1/orphan.bin`, 'raw');

    const [listed] = (await driver.list({ prefix: 'org/org-1/' })).objects;
    expect(listed?.key).toBe('org/org-1/orphan.bin');
    expect(listed?.contentType).toBeUndefined();
    // `get()` still answers a full StorageObject: a read has a type to serve with.
    expect((await driver.get('org/org-1/orphan.bin')).object.contentType).toBe(
      'application/octet-stream',
    );
  });

  test('an unsafe key never reaches the file system', async () => {
    const escapee = `escaped-${crypto.randomUUID()}.png`;
    let caught: unknown;
    try {
      await driver.put(`../${escapee}`, bytesOf('x'));
    } catch (error) {
      caught = error;
    }
    expect(isStorageError(caught) ? caught.code : '').toBe('X_STORAGE_PATH_UNSAFE');
    expect(await Bun.file(`${root}/../${escapee}`).exists()).toBe(false);
  });

  test('the reserved .meta namespace is refused at the driver boundary, not just by the validator', async () => {
    // `put('a/b', png)` writes its sidecar to `<root>/.meta/a/b.json`. If `.meta/a/b.json` were a
    // legal key, an uploader could rewrite the recorded contentType of `a/b` to `text/html` and
    // have the read route serve attacker HTML from the app's own origin. Asserted through every
    // method, because a guard is only where it is written.
    const reserved = `${META_DIR}/org/org-1/a.png.json`;
    expect(
      await Promise.all([
        catchCode(() => driver.put(reserved, bytesOf('x'))),
        catchCode(() => driver.get(reserved)),
        catchCode(() => driver.stream(reserved)),
        catchCode(() => driver.exists(reserved)),
        catchCode(() => driver.delete(reserved)),
        catchCode(() => driver.signedUrl(reserved)),
      ]),
    ).toEqual(Array(6).fill('X_STORAGE_PATH_UNSAFE'));
    expect(await Bun.file(`${root}/${reserved}`).exists()).toBe(false);

    // Only the FIRST segment is reserved: a tenant key of its own named `.meta` collides with
    // nothing, since its sidecar lands under `<root>/.meta/org/org-1/.meta/…`.
    const scoped = scopedKey('org-1', META_DIR, 'a.json');
    await driver.put(scoped, bytesOf('ordinary'), { contentType: 'application/json' });
    expect(textOf((await driver.get(scoped)).bytes)).toBe('ordinary');
  });

  test('list paginates by cursor in lexicographic order', async () => {
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await driver.put(`org/org-1/${name}`, bytesOf(name), { contentType: 'text/plain' });
    }
    const first = await driver.list({ prefix: 'org/org-1/', limit: 2 });
    expect(first.objects.map((object) => object.key)).toEqual([
      'org/org-1/a.txt',
      'org/org-1/b.txt',
    ]);
    expect(first.truncated).toBe(true);

    const second = await driver.list({ prefix: 'org/org-1/', limit: 2, cursor: first.cursor });
    expect(second.objects.map((object) => object.key)).toEqual(['org/org-1/c.txt']);
    expect(second.truncated).toBe(false);
  });

  test('signedUrl is verifiable and carries the constraints', async () => {
    const url = await driver.signedUrl('org/org-1/a.png', {
      method: 'PUT',
      maxBytes: 2048,
      contentType: 'image/png',
    });
    expect(url.startsWith('/_storage/local/org/org-1/a.png?')).toBe(true);
    expect(url).toContain('x-max=2048');
  });

  test('stream yields the stored bytes', async () => {
    await driver.put('org/org-1/s.txt', bytesOf('streamed'), { contentType: 'text/plain' });
    const stream = await driver.stream('org/org-1/s.txt');
    expect(await new Response(stream).text()).toBe('streamed');
  });
});

describe('the dev signing secret', () => {
  // The env key the driver itself declares — a rename must break this test, not slip past it
  // because the test spelled the old name out a second time.
  const KEY = STORAGE_SIGNING_SECRET_KEY;
  const ENV = 'ULTIMATE_ENV';
  let previousSecret: string | undefined;
  let previousEnv: string | undefined;

  beforeEach(() => {
    previousSecret = process.env[KEY];
    previousEnv = process.env[ENV];
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env[KEY];
    else process.env[KEY] = previousSecret;
    if (previousEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = previousEnv;
  });

  test('usesDevStorageSecret reports the shipped key, exactly as the cursor one does', () => {
    delete process.env[KEY];
    expect(usesDevStorageSecret()).toBe(true);
    process.env[KEY] = '';
    expect(usesDevStorageSecret()).toBe(true);
    process.env[KEY] = DEV_SIGNING_SECRET;
    expect(usesDevStorageSecret()).toBe(true);
    process.env[KEY] = 'a-real-secret';
    expect(usesDevStorageSecret()).toBe(false);
  });

  /** The code `localDriver` refused to construct with, or how it failed to refuse. */
  const bootCode = (options: { readonly signingSecret?: string }): string => {
    try {
      localDriver({ root, ...options });
    } catch (error) {
      return isStorageError(error) ? error.code : `not-a-storage-error: ${String(error)}`;
    }
    return 'no-throw';
  };

  test('a production disk refuses to boot with no secret at all', () => {
    // The literal is in this repo, so anyone holding it can mint a PUT for any key with any
    // maxBytes and contentType — and acceptSignedUpload trusts the signed constraints over the
    // app's own uploadPolicy. Refused at construction, so the boot fails, not the first upload.
    for (const environment of ['production', 'staging']) {
      process.env[ENV] = environment;
      delete process.env[KEY];
      expect(bootCode({})).toBe('X_ENV_MISSING');
      process.env[KEY] = '';
      expect(bootCode({})).toBe('X_ENV_MISSING');
    }
  });

  test('a production disk refuses to boot ON the published key, however it arrives', () => {
    // Setting STORAGE_SIGNING_SECRET to the published literal is not configuring a secret, it is
    // spelling the fallback out — and pasting it into `app.config.ts` is the same key again.
    // Both used to boot, and a booted process signs grants anyone in this repo can forge.
    for (const environment of ['production', 'staging']) {
      process.env[ENV] = environment;
      process.env[KEY] = DEV_SIGNING_SECRET;
      expect(bootCode({})).toBe('X_ENV_MISSING');
      delete process.env[KEY];
      expect(bootCode({ signingSecret: DEV_SIGNING_SECRET })).toBe('X_ENV_MISSING');
    }
  });

  test('the refusal names the resolved environment, whichever variable resolved it', () => {
    // resolveEnvironment() reads NODE_ENV when ULTIMATE_ENV is unset, so a cause that blamed
    // ULTIMATE_ENV reported a variable this process never set.
    delete process.env[KEY];
    process.env[ENV] = 'staging';
    let cause = '';
    try {
      localDriver({ root });
    } catch (error) {
      cause = isStorageError(error) ? error.cause : String(error);
    }
    expect(cause).toContain('the resolved environment is "staging"');
    expect(cause).not.toContain('ULTIMATE_ENV');
  });

  test('the dev key still signs a dev disk, so `x dev` needs no configuration', () => {
    // The whole point of the fallback: zero-config locally, refused everywhere else.
    process.env[ENV] = 'development';
    process.env[KEY] = DEV_SIGNING_SECRET;
    expect(localDriver({ root }).name).toBe('local');
    delete process.env[KEY];
    expect(localDriver({ root }).name).toBe('local');
  });

  test('a production disk with a real secret boots, and dev still needs none', () => {
    process.env[ENV] = 'production';
    process.env[KEY] = 'a-real-secret';
    expect(localDriver({ root }).name).toBe('local');
    delete process.env[KEY];
    expect(localDriver({ root, signingSecret: 'passed-in' }).name).toBe('local');
    process.env[ENV] = 'development';
    expect(localDriver({ root }).name).toBe('local');
  });
});
