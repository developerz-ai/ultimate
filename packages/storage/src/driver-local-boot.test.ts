// Single responsibility: what `localDriver()` refuses to be CONSTRUCTED with — the published dev
// signing secret outside development, and a byte ceiling that is not a whole positive number. Both
// are boot-time refusals, so no test here writes a byte: the `root` below is never created.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun exposes no `tmpdir()`; `node:os` is the only way to ask the platform where its
// temporary directory is.
import { tmpdir } from 'node:os';
import { isLocal } from '@ultimat3/core';
import {
  DEV_SIGNING_SECRET,
  type LocalDriverOptions,
  localDriver,
  STORAGE_SIGNING_SECRET_KEY,
  usesDevStorageSecret,
} from './driver-local';
import { isStorageError } from './errors';

// A path, not a directory: construction reads its argument and never touches the file system.
const root = `${tmpdir()}/ultimate-storage-boot`;

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
  const bootCode = (options: Omit<LocalDriverOptions, 'root'>): string => {
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

  test('the predicate reads the env it is handed, never the process it happens to run in', () => {
    // The two halves of one guard. `dev-runtime.ts` asks `!isLocal({ env }) &&
    // usesDevStorageSecret({ env })` — and until this option existed the second half answered
    // about `process.env` while the first answered about the boot, so an embedding caller
    // (`serveApp({ env })`, a test fixture, `@ultimat3/testing`) whose env differs got a verdict
    // assembled from two different processes. The dangerous direction is this one: the boot has
    // no secret, the process that launched it does, and the disk signs with the published key.
    const wouldSignWithTheDevKey = (env: Readonly<Record<string, string | undefined>>): boolean =>
      !isLocal({ env }) && usesDevStorageSecret({ env });

    process.env[ENV] = 'development';
    process.env[KEY] = 'a-real-secret';
    expect(wouldSignWithTheDevKey({ ULTIMATE_ENV: 'production' })).toBe(true);
    expect(wouldSignWithTheDevKey({ ULTIMATE_ENV: 'production', [KEY]: 'a-real-secret' })).toBe(
      false,
    );

    // And the reverse, which is a boot refused over a secret it actually has.
    delete process.env[KEY];
    expect(wouldSignWithTheDevKey({ ULTIMATE_ENV: 'production', [KEY]: 'boot-secret' })).toBe(
      false,
    );

    // An empty table is a boot that declared nothing, not a fall-through to `process.env`.
    process.env[KEY] = 'a-real-secret';
    expect(usesDevStorageSecret({ env: {} })).toBe(true);
    expect(usesDevStorageSecret({ env: { [KEY]: DEV_SIGNING_SECRET } })).toBe(true);
    expect(usesDevStorageSecret({ env: { [KEY]: '' } })).toBe(true);
  });

  test('no options is still the process, so no existing caller changes answer', () => {
    // `x doctor` and `dev-runtime.ts` both call it bare today; the option is additive.
    process.env[KEY] = 'a-real-secret';
    expect(usesDevStorageSecret()).toBe(false);
    expect(usesDevStorageSecret({})).toBe(false);
    delete process.env[KEY];
    expect(usesDevStorageSecret()).toBe(true);
    expect(usesDevStorageSecret({})).toBe(true);
  });

  test('the DRIVER reads the env it is handed, never the process it happens to run in', () => {
    // The other half of the guard above. `usesDevStorageSecret({ env })` asks about the BOOT's
    // table; `localDriver` — the constructor that actually decides whether this disk signs with
    // the published key — read `process.env`, so `x doctor` and the disk it reports on answered
    // about two different processes. The dangerous direction is this one: the boot is production
    // and declares no secret, the shell that launched it is development and has one, and the disk
    // signed every grant with a key published in this repo.
    process.env[ENV] = 'development';
    process.env[KEY] = 'a-real-secret';
    expect(bootCode({ env: { ULTIMATE_ENV: 'production' } })).toBe('X_ENV_MISSING');
    expect(bootCode({ env: { ULTIMATE_ENV: 'production', [KEY]: DEV_SIGNING_SECRET } })).toBe(
      'X_ENV_MISSING',
    );
    // An empty table is a boot that declared nothing, which resolves to `development` — the same
    // reading `usesDevStorageSecret({ env: {} })` takes, never a fall-through to `process.env`.
    expect(bootCode({ env: {} })).toBe('no-throw');

    // The cause names the environment the BOOT resolved. Reading `process.env` here would report
    // `production` for a disk refused over a `staging` deploy, which is a fix aimed at the wrong
    // machine.
    process.env[ENV] = 'production';
    delete process.env[KEY];
    let cause = '';
    try {
      localDriver({ root, env: { ULTIMATE_ENV: 'staging' } });
    } catch (error) {
      cause = isStorageError(error) ? error.cause : 'not-a-storage-error';
    }
    expect(cause).toContain('the resolved environment is "staging"');

    // And the reverse, which is a boot refused over a secret it actually holds.
    expect(bootCode({ env: { ULTIMATE_ENV: 'production', [KEY]: 'boot-secret' } })).toBe(
      'no-throw',
    );
    expect(bootCode({ env: { ULTIMATE_ENV: 'development' } })).toBe('no-throw');
  });

  test('no env is still the process, so no existing localDriver caller changes answer', () => {
    // `defineStorage` and every app config call it with no `env` today; the option is additive.
    process.env[ENV] = 'production';
    delete process.env[KEY];
    expect(bootCode({})).toBe('X_ENV_MISSING');
    process.env[KEY] = 'a-real-secret';
    expect(bootCode({})).toBe('no-throw');
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

/**
 * `maxPutBytes` is the only thing between a `put()` of a stream and this process's memory: it is
 * handed to `toBytes` as the cap, and `bytes.length > NaN` is false for every length. A driver
 * built with one is a driver with no ceiling at all, and nothing downstream can notice.
 */
describe('the driver byte ceiling is screened at construction', () => {
  test.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5])(
    'refuses maxPutBytes %p, naming it',
    (maxPutBytes) => {
      let rendered = 'no-error-thrown';
      try {
        localDriver({ root, signingSecret: 'test-secret', maxPutBytes });
      } catch (error) {
        rendered = String(error);
      }
      expect(rendered).toContain('X_INVARIANT');
      expect(rendered).toContain('maxPutBytes');
    },
  );

  test('a real ceiling still builds a driver', () => {
    expect(typeof localDriver({ root, signingSecret: 'test-secret', maxPutBytes: 1024 }).put).toBe(
      'function',
    );
  });
});

/**
 * `??` coalesces on `null` as well as `undefined`, so an explicit `null` — what a decoded JSON
 * config carries for a key someone blanked — took the default BEFORE the guard above could refuse
 * it. The mirror of the `NaN` half: one slips past the guard, the other past the default, and both
 * end in a bound nobody chose. `JSON.parse` rather than a literal, because `null` is not in the
 * option's type and this is the caller the bug is about.
 */
describe('an explicitly null byte ceiling is refused, never defaulted', () => {
  test('localDriver({ maxPutBytes: null }) names maxPutBytes', () => {
    const fromJson: number = JSON.parse('null');
    let rendered = 'no-error-thrown';
    try {
      localDriver({ root, signingSecret: 'test-secret', maxPutBytes: fromJson });
    } catch (error) {
      rendered = String(error);
    }
    expect(rendered).toContain('X_INVARIANT');
    expect(rendered).toContain('maxPutBytes');
  });
});
