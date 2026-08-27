// The storage disk a boot installs, and the two refusals that must arrive before the first upload
// rather than after it. Split from `dev-runtime.test.ts` at the 500-line ceiling: mail and the CDN
// are that file's subject, and a disk is this one's.

import { describe, expect, test } from 'bun:test';
// why: `node:` by necessity: Bun has no temp-directory, no mkdtemp, no chmod and no recursive
// remove.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import { startStorage } from './dev-runtime';
import type { DevServices } from './dev-services';

/** Module scope, not per-describe: two suites in this file ask about the same boot's disk. */
const servicesAt = (stateDir: string, storageUrl: string, mode: 'embedded' | 'external') =>
  ({
    db: { name: 'db', mode: 'embedded', url: '', detail: '' },
    events: { name: 'events', mode: 'embedded', url: '', detail: '' },
    storage: { name: 'storage', mode, url: storageUrl, detail: '' },
    stateDir,
  }) as unknown as DevServices;

/**
 * The storage disk this process resolves. Both cases below are production failures the demo hit,
 * not hypotheticals: the read-only one CrashLooped a hardened container 22 times on a bare EROFS,
 * and the external one silently wrote every upload to a container-local disk that the next restart
 * destroyed, while the configured bucket stayed empty and nothing reported a problem.
 */
describe('unit · the storage binding a process boots with', () => {
  test('an unwritable embedded root is X_STORAGE_UNWRITABLE, not a bare EROFS', () => {
    // 0o500 = r-x: the directory exists and mkdir inside it is refused, which is what a
    // readOnlyRootFilesystem does to the app root. The old code let Bun's own EROFS escape with
    // no code, no fix, and no mention of storage.
    const parent = mkdtempSync(join(tmpdir(), 'x-storage-ro-'));
    const denied = join(parent, 'nested');
    mkdirSync(denied, { recursive: true });
    chmodSync(denied, 0o500);
    try {
      const services = servicesAt(parent, `file://${join(denied, 'storage')}`, 'embedded');
      const failure = (() => {
        try {
          return startStorage(services, {});
        } catch (error) {
          return error;
        }
      })();
      expect(failure).toBeInstanceOf(UltimateError);
      const error = failure as UltimateError;
      expect(error.code).toBe('X_STORAGE_UNWRITABLE');
      // The fix has to name BOTH ways out, because the command cannot know which one is wanted.
      expect(error.fix).toContain('writable volume');
      expect(error.fix).toContain('S3_ENDPOINT');
      expect(error.cause).toContain(denied);
    } finally {
      chmodSync(denied, 0o700);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('an external binding builds an object disk and never touches the filesystem', () => {
    // The regression that matters: this used to fall through to a LOCAL directory, so S3_ENDPOINT
    // changed the root and nothing else. A path that does not exist proves nothing was mkdir'd.
    const absent = join(tmpdir(), 'x-storage-must-not-exist', String(process.pid));
    const services = servicesAt(absent, 'https://account.r2.cloudflarestorage.com', 'external');
    const storage = startStorage(services, { S3_BUCKET: 'uploads' });
    expect(storage.disk().name).not.toBe('local');
    expect(existsSync(absent)).toBe(false);
  });

  test('an external binding with no bucket fails at boot, not at the first upload', () => {
    const services = servicesAt(tmpdir(), 'https://account.r2.cloudflarestorage.com', 'external');
    const failure = (() => {
      try {
        return startStorage(services, { S3_BUCKET: '' });
      } catch (error) {
        return error;
      }
    })();
    expect((failure as UltimateError).code).toBe('X_STORAGE_UNWRITABLE');
  });

  /**
   * The guard deciding whether the LOCAL disk may be signed with the secret published in this repo
   * read `process.env` while `startStorage` was holding an `env` parameter it reads `S3_BUCKET`,
   * `S3_REGION` and `S3_FORCE_PATH_STYLE` off, one branch above. Two sources for one boot's
   * environment, and the one that decides a security question was the one nobody passed.
   */
  test('the environment the safety guard reads is the boot`s own env, not process.env', () => {
    const root = mkdtempSync(join(tmpdir(), 'x-storage-env-'));
    const services = servicesAt(root, `file://${join(root, 'storage')}`, 'embedded');
    const failure = (() => {
      try {
        // No STORAGE_SIGNING_SECRET anywhere, so the disk would be signed with the dev key.
        return startStorage(services, { ULTIMATE_ENV: 'production' });
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(UltimateError);
    const error = failure as UltimateError;
    expect(error.code).toBe('X_ENV_MISSING');
    // The environment it names is the one it was HANDED — reading `process.env` here answered
    // `test`, and the refusal never fired at all.
    expect(error.cause).toContain('production');
    rmSync(root, { recursive: true, force: true });
  });

  test('and a local environment in that same env still boots the embedded disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'x-storage-env-ok-'));
    const services = servicesAt(root, `file://${join(root, 'storage')}`, 'embedded');
    expect(startStorage(services, { ULTIMATE_ENV: 'development' }).disk().name).toBe('local');
    rmSync(root, { recursive: true, force: true });
  });
});

/**
 * The guard is ONE question asked of ONE table. `isLocal`, `resolveEnvironment` and
 * `usesDevStorageSecret` are three reads in a single expression, and until all three took the
 * boot's `env` the guard asked two different things: "which environment is this BOOT" and "what
 * does this PROCESS have". An embedding caller — `serveApp({ env })`, a test fixture,
 * `@ultimat3/testing` — whose `env` is not `process.env` got a split verdict, on the decision of
 * whether a disk may be signed with the key published in `@ultimat3/storage`.
 */
describe('unit · the local-disk safety guard reads one environment', () => {
  // The precondition that makes the case below mean anything: the SECRET must be absent from the
  // process, so the only place it can be found is the `env` the boot was handed.
  test('the process itself declares no storage signing secret', () => {
    expect(process.env['STORAGE_SIGNING_SECRET']).toBeUndefined();
  });

  test('a production boot that DECLARES a real secret is not refused', () => {
    const root = mkdtempSync(join(tmpdir(), 'x-storage-secret-'));
    const services = servicesAt(root, `file://${join(root, 'storage')}`, 'embedded');
    // `usesDevStorageSecret()` read `process.env`, found nothing, answered "yes, the dev key" —
    // and refused a boot whose own environment carries a real one. The single-node Compose rung
    // on a mounted volume WITH a secret is exactly the deploy this must not block.
    const storage = startStorage(services, {
      ULTIMATE_ENV: 'production',
      STORAGE_SIGNING_SECRET: 'a-real-secret-that-is-not-the-published-one',
    });
    expect(storage.disk().name).toBe('local');
    rmSync(root, { recursive: true, force: true });
  });

  test('and a production boot with no secret is still refused, naming that environment', () => {
    const root = mkdtempSync(join(tmpdir(), 'x-storage-nosecret-'));
    const services = servicesAt(root, `file://${join(root, 'storage')}`, 'embedded');
    const failure = (() => {
      try {
        return startStorage(services, { ULTIMATE_ENV: 'production' });
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(UltimateError);
    expect((failure as UltimateError).cause).toContain('production');
    rmSync(root, { recursive: true, force: true });
  });
});
