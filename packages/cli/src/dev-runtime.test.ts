// The mail and CDN seams of the dev/production boot: which transport and which edge a process
// installs, and how it says so. The other services are covered by `cmd-dev.test.ts`, which boots
// them for real.

import { afterAll, describe, expect, test } from 'bun:test';
// `node:` by necessity: Bun has no temp-directory, no mkdtemp and no recursive remove.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PurgeDriver } from '@ultimat3/cache';
import { noopPurgeDriver, registeredTiers, resetTiers } from '@ultimat3/cache';
import { readinessCheckCount, UltimateError } from '@ultimat3/core';
import { jobDriver } from '@ultimat3/jobs';
import type { MailDriver } from '@ultimat3/mail';
import { createMemoryDriver, tryMailDriver } from '@ultimat3/mail';
import { TransportUnavailableError } from '@ultimat3/realtime';
import { DEFAULT_PRESENCE_TTL_MS, selectTransport } from '@ultimat3/realtime/server';
import {
  cdnLabel,
  describeCdn,
  describeMail,
  mailLabel,
  type RunningServices,
  startServices,
  startStorage,
} from './dev-runtime';
import type { DevServices } from './dev-services';
import { resolveServices } from './dev-services';
import { CliNotImplementedError } from './errors';

const runtimeWith = (mail: MailDriver, mailDetail: string): RunningServices =>
  ({ mail, mailDetail }) as unknown as RunningServices;

const cdnRuntimeWith = (purge: PurgeDriver, purgeDetail: string): RunningServices =>
  ({ purge, purgeDetail }) as unknown as RunningServices;

/**
 * `describeMail` reads `name` and `mailDetail`, never `send` — so this one exists only to satisfy
 * `MailDriver`, and it refuses with a code carrying a runnable fix. Never a bare Error, tests
 * included: a throw without a code and a fix is not an instruction to whoever reaches it.
 */
const fakeSmtp = (): MailDriver => ({
  name: 'smtp',
  send: (): Promise<never> =>
    Promise.reject(
      new CliNotImplementedError({
        feature: 'sending through the describeMail fixture transport',
        fix: 'x dev   # boots the transport SMTP_URL selects, which does send',
      }),
    ),
});

/**
 * One embedded-Postgres directory for the whole file, not one per boot. Every case below stops its
 * runtime before the next starts — on the failure path too, since `startServices` unwinds what it
 * started — so the data dir is never held twice. Reusing it is the difference between paying
 * `initdb` once and paying it per test: a cold boot measures ~2.6s and a warm one ~0.3s, which was
 * seven eighths of this file's runtime.
 */
const root = mkdtempSync(join(tmpdir(), 'x-dev-boot-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('describeMail', () => {
  test('a caught outbox reports as embedded, like the other bindings', () => {
    expect(describeMail(runtimeWith(createMemoryDriver(), 'caught in memory'))).toBe(
      'mail=embedded',
    );
  });

  test('a real transport names itself and the env key that selected it', () => {
    expect(describeMail(runtimeWith(fakeSmtp(), 'SMTP_URL'))).toBe(
      'mail=external(smtp via SMTP_URL)',
    );
  });

  // The boot line is printed, logged and scraped. `SMTP_URL` holds a password, so the detail is
  // the key's name and never its value — this is the assertion that keeps it that way.
  test('the report carries the env key, never the credential behind it', () => {
    expect(describeMail(runtimeWith(fakeSmtp(), 'SMTP_URL'))).not.toContain('@');
  });
});

/**
 * The status value `--json` carries and the label the boot line prints are two surfaces of one
 * fact, and `wiki/Configuration.md` quotes both — so a catalog edit that moves the printed line
 * without moving the documented status has to fail here rather than in a script that parses it.
 */
describe('the rendered label and the machine status', () => {
  test('agree for every mail case', () => {
    const memory = runtimeWith(createMemoryDriver(), 'caught in memory');
    expect(mailLabel(memory)).toBe(describeMail(memory));
    const smtp = runtimeWith(fakeSmtp(), 'SMTP_URL');
    expect(mailLabel(smtp)).toBe(describeMail(smtp));
  });

  test('agree for every cdn case', () => {
    const none = cdnRuntimeWith(noopPurgeDriver(), 'no edge');
    expect(cdnLabel(none)).toBe(describeCdn(none));
    const fastly = cdnRuntimeWith(
      { name: 'fastly', purge: () => Promise.resolve([]), purgeAll: () => Promise.resolve() },
      'FASTLY_API_TOKEN',
    );
    expect(cdnLabel(fastly)).toBe(describeCdn(fastly));
  });
});

/**
 * Two readers of `NATS_URL`: `resolveServices` for the boot line an operator reads, and
 * `selectTransport` for the object the process actually fans out on. A boot that printed
 * `events=external` while running the in-process transport would be the worst of both, so the two
 * answers are pinned against each other rather than trusted to stay in step.
 */
describe('the reported binding and the selected transport', () => {
  test('agree that no url is embedded', () => {
    expect(resolveServices(root, {}).events.mode).toBe(selectTransport({}).mode);
  });

  test('agree that a url — even a padded one — is external', () => {
    const env = { NATS_URL: '  nats://bus.test:4222  ' };
    expect(resolveServices(root, env).events.mode).toBe(selectTransport(env).mode);
    expect(selectTransport(env).mode).toBe('external');
  });
});

describe('describeCdn', () => {
  // There is no embedded CDN. Reporting one would read as a fifth service this boot started.
  test('no credential reports no edge, not an embedded one', () => {
    expect(describeCdn(cdnRuntimeWith(noopPurgeDriver(), 'no edge'))).toBe('cdn=none');
  });

  test('a real driver names itself and the env key that selected it', () => {
    const fastly: PurgeDriver = {
      name: 'fastly',
      purge: () => Promise.resolve([]),
      purgeAll: () => Promise.resolve(),
    };
    expect(describeCdn(cdnRuntimeWith(fastly, 'FASTLY_API_TOKEN'))).toBe(
      'cdn=external(fastly via FASTLY_API_TOKEN)',
    );
  });
});

describe('startServices', () => {
  /**
   * Selection runs before the queue, so a bad credential rejects without booting PGlite. That
   * ordering is the assertion: this test hands `startServices` a `DevServices` with no usable
   * state directory, and it must still reject on the environment alone. If the env stopped being
   * threaded through, or selection moved after `startQueue`, this would boot instead of throwing.
   */
  test('refuses two credentials before any service starts', async () => {
    const unusable = { stateDir: '/nonexistent/x-dev-should-never-be-read' } as DevServices;
    const failure = await startServices(unusable, {
      SMTP_URL: 'smtps://user:pass@mail.test:465',
      RESEND_API_KEY: 're_test_key',
      MAIL_FROM: 'Postly <no-reply@postly.test>',
    }).then(
      () => undefined,
      (error: unknown) => error as { code?: string; cause?: string },
    );

    expect(failure?.code).toBe('X_CONFIG_INVALID');
    expect(failure?.cause).toContain('both set');
  });

  /**
   * The whole point of the task: a credential in the environment makes `mailDriver()` a real
   * transport, so `send()` reaches a server instead of an outbox nobody drains. Booted for real
   * because the ambient install is the thing under test — a fake `DevServices` would prove that
   * `selectMailDriver` returns an object, which is already covered in `@ultimat3/mail`.
   */
  test(
    'a credential in the environment installs the transport as the ambient driver',
    async () => {
      const runtime = await startServices(resolveServices(root, {}), {
        SMTP_URL: 'smtps://user:pass@mail.postly.test:465',
        MAIL_FROM: 'Postly <no-reply@postly.test>',
      });
      try {
        // The ambient accessor, not the return value: `send()` resolves the driver through this.
        expect(tryMailDriver()?.name).toBe('smtp');
        expect(runtime.mail.name).toBe('smtp');
        expect(describeMail(runtime)).toBe('mail=external(smtp via SMTP_URL)');
      } finally {
        await runtime.stop();
      }
      // Released on stop, so the next process does not inherit a transport it never configured.
      expect(tryMailDriver()).toBeUndefined();
    },
    { timeout: 60_000 },
  );

  test(
    'no credential leaves the caught outbox in place',
    async () => {
      const runtime = await startServices(resolveServices(root, {}), {});
      try {
        expect(tryMailDriver()?.name).toBe('memory');
        expect(describeMail(runtime)).toBe('mail=embedded');
      } finally {
        await runtime.stop();
      }
    },
    { timeout: 60_000 },
  );

  /**
   * The CDN leg of `invalidates: [tag.post]`: without this registration the purge drivers are
   * code nothing can reach, and a bust that should have cleared the edge reports four tiers and
   * no fifth. Booted for real, because the registry is process-global and the install is the
   * thing under test.
   */
  test(
    'a CDN credential registers the cdn tier, and stopping releases it',
    async () => {
      resetTiers();
      const runtime = await startServices(resolveServices(root, {}), {
        FASTLY_API_TOKEN: 'fastly-token',
        FASTLY_SERVICE_ID: 'svc_1',
      });
      try {
        // The two that need no external state are always registered — `createMemoTier` and
        // `createLruTier` had zero callers before this boot did, so every cached read was
        // recomputed on every replica. `cdn` joins them only for a real edge.
        expect(registeredTiers().map((tier) => tier.name)).toEqual(['request-memo', 'lru', 'cdn']);
        expect(runtime.purge.name).toBe('fastly');
        expect(describeCdn(runtime)).toBe('cdn=external(fastly via FASTLY_API_TOKEN)');
      } finally {
        await runtime.stop();
      }
      expect(registeredTiers()).toHaveLength(0);
    },
    { timeout: 60_000 },
  );

  /**
   * A noop tier would put a `cdn` line in every invalidation report — keys accepted by an edge
   * that does not exist — and the `/_x` cache panel renders those reports verbatim.
   */
  test(
    'no CDN credential registers no cdn tier at all',
    async () => {
      resetTiers();
      const runtime = await startServices(resolveServices(root, {}), {});
      try {
        // No `cdn`, and the two process-local tiers still there: "no edge" is not "no cache".
        expect(registeredTiers().map((tier) => tier.name)).toEqual(['request-memo', 'lru']);
        expect(describeCdn(runtime)).toBe('cdn=none');
      } finally {
        await runtime.stop();
      }
    },
    { timeout: 60_000 },
  );

  /**
   * The leak this pins: `stop()` awaited `transport.close()` and returned on its rejection, so
   * `resetTiers()`, `resetMailDriver()` and `queue.stop()` never ran — and the next boot in this
   * process inherited a CDN tier purging for a stopped server, an ambient mail driver over a dead
   * transport, and a queue nobody owns. Every release must run; the FIRST failure is what surfaces,
   * because a shutdown that reports the cleanup it did after the real fault buries the fault.
   */
  test(
    'a transport that will not close still releases the tier, the mail driver and the queue',
    async () => {
      resetTiers();
      const runtime = await startServices(resolveServices(root, {}), {
        SMTP_URL: 'smtps://user:pass@mail.postly.test:465',
        MAIL_FROM: 'Postly <no-reply@postly.test>',
        FASTLY_API_TOKEN: 'fastly-token',
        FASTLY_SERVICE_ID: 'svc_1',
      });
      expect(registeredTiers()).toHaveLength(3);
      expect(tryMailDriver()?.name).toBe('smtp');
      expect(jobDriver()).toBeDefined();
      // The only thing this case changes: a bus that is already gone by the time shutdown asks.
      runtime.transport.close = (): Promise<never> =>
        Promise.reject(
          new TransportUnavailableError({ transport: 'inproc', reason: 'closed by the fixture' }),
        );

      await expect(runtime.stop()).rejects.toBeUltimateError('X_TRANSPORT_UNAVAILABLE');

      // The three releases the rejection used to skip, each read back through the accessor a later
      // boot would inherit — asserting `stop()` rejected proves nothing about what it released.
      expect(registeredTiers()).toHaveLength(0);
      expect(tryMailDriver()).toBeUndefined();
      expect(jobDriver()).toBeUndefined();
    },
    { timeout: 60_000 },
  );

  /**
   * The bus is the third selection that must land before `startQueue`: a bucket name that cannot
   * be a NATS subject is a boot that reports a healthy transport and then fails every presence
   * write, and finding that out after PGlite has started and been unwound again helps nobody.
   */
  test('an unusable KV bucket refuses before any service starts', async () => {
    const unusable = { stateDir: '/nonexistent/x-dev-should-never-be-read' } as DevServices;
    const failure = await startServices(unusable, {
      NATS_URL: 'nats://bus.test:4222',
      NATS_KV_BUCKET: 'x.presence',
    }).then(
      () => undefined,
      (error: unknown) => error as { code?: string; fix?: string },
    );

    expect(failure?.code).toBe('X_TRANSPORT_PROTOCOL');
    expect(failure?.fix).toContain('NATS_KV_BUCKET');
  });

  test(
    'the embedded bus reports the key that would change it, and the TTL presence gets',
    async () => {
      const runtime = await startServices(resolveServices(root, {}), {});
      try {
        expect(runtime.transportDetail).toContain('NATS_URL');
        // Handed to `PresenceRegistry` by the sync role. It is the transport's number, not the
        // role's, because the KV bucket's age limit was derived from the same one.
        expect(runtime.presenceTtlMs).toBe(DEFAULT_PRESENCE_TTL_MS);
      } finally {
        await runtime.stop();
      }
    },
    { timeout: 60_000 },
  );

  test(
    'the boot resolves the SHARED rate-limit store, over the pool it already opened',
    async () => {
      const runtime = await startServices(resolveServices(root, {}), {});
      try {
        // Observed before this landed: `undefined` — no boot in the tree installed a store, so
        // `startWeb` derived `rateLimit.scope: 'process'` while the shipped chart runs three `web`
        // replicas, each enforcing the whole of every declared limit.
        expect(runtime.rateLimitStore?.scope).toBe('shared');
        // The pool this boot opened, never a second one: `Bun.sql` does not satisfy `PgExecutor`
        // at all, and the store has to be able to run its statement.
        expect(readinessCheckCount()).toBeGreaterThan(0);
      } finally {
        await runtime.stop();
      }
    },
    { timeout: 60_000 },
  );

  test('a half-set CDN pair refuses before any service starts', async () => {
    const unusable = { stateDir: '/nonexistent/x-dev-should-never-be-read' } as DevServices;
    const failure = await startServices(unusable, { FASTLY_API_TOKEN: 'fastly-token' }).then(
      () => undefined,
      (error: unknown) => error as { code?: string; cause?: string },
    );

    expect(failure?.code).toBe('X_CONFIG_INVALID');
    expect(failure?.cause).toContain('FASTLY_SERVICE_ID');
  });
});

/**
 * The storage disk this process resolves. Both cases below are production failures the demo hit,
 * not hypotheticals: the read-only one CrashLooped a hardened container 22 times on a bare EROFS,
 * and the external one silently wrote every upload to a container-local disk that the next restart
 * destroyed, while the configured bucket stayed empty and nothing reported a problem.
 */
describe('unit · the storage binding a process boots with', () => {
  const servicesAt = (stateDir: string, storageUrl: string, mode: 'embedded' | 'external') =>
    ({
      db: { name: 'db', mode: 'embedded', url: '', detail: '' },
      events: { name: 'events', mode: 'embedded', url: '', detail: '' },
      storage: { name: 'storage', mode, url: storageUrl, detail: '' },
      stateDir,
    }) as unknown as DevServices;

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
});
