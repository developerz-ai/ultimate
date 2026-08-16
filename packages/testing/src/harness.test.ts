// A fake `boot` proves the harness lifecycle contract without a real server behind it. The
// determinism and the seal it installs are process-global and bun shares one process across files,
// so the last describe below asserts the teardown put back exactly what it found — this file used
// to repair that by hand in an `afterAll`, which fixed the leak here and nowhere else.

import { describe, expect, test } from 'bun:test';
import { isDeterminismInstalled, seededRandom } from './determinism';
import type { AppOptions, BootedApp, HarnessDeps } from './harness';
import { bootApp, describeApp, testApp } from './harness';
import { isNetworkSealed, requestedUrls } from './sealed-network';
import type { WorkerDatabase } from './template-db';
import { testName } from './test-types';

// Sampled at module scope, which is after the preload installed determinism and sealed the
// network and before any boot below has run: these three ARE the process state the harness must
// leave behind. `Math.random` by identity, because `installDeterminism` swaps in a fresh
// generator — an equal value would pass against a re-seeded one.
const RANDOM_BEFORE = Math.random;
const NOW_BEFORE = Date.now();
const SEALED_BEFORE = isNetworkSealed();

interface Recorder {
  readonly sequence: string[];
  seededUrl: string | undefined;
  closed: boolean;
}

function recorder(): Recorder {
  return { sequence: [], seededUrl: undefined, closed: false };
}

/** Nothing listens here, so a request that gets past the seal fails locally and immediately. */
const CLOSED_PORT = 59_431;

/** `undefined` when the request unexpectedly succeeded — which then fails the assertion. */
const failureCode = async (url: string): Promise<string | undefined> =>
  fetch(url).then(
    () => undefined,
    (error: unknown) => (error as { code?: string }).code ?? 'no-code',
  );

function fakeBoot(rec: Recorder): AppOptions['boot'] {
  return async ({ databaseUrl }) => {
    rec.sequence.push('boot');
    const app: BootedApp = {
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === '/echo') {
          return Response.json({ pathname: url.pathname, method: request.method });
        }
        return new Response('not found', { status: 404 });
      },
      close: async () => {
        rec.closed = true;
      },
    };
    void databaseUrl;
    return app;
  };
}

describe(testName('unit', 'describeApp lifecycle'), () => {
  const rec = recorder();

  describeApp(
    'a fake app',
    {
      boot: fakeBoot(rec),
      seed: async (databaseUrl) => {
        rec.sequence.push('seed');
        rec.seededUrl = databaseUrl;
      },
    },
    (app) => {
      test('seed runs before boot, against the same database the handle exposes', () => {
        expect(rec.sequence).toEqual(['seed', 'boot']);
        expect(rec.seededUrl).toBe(app().db.url);
        expect(typeof app().db.drop).toBe('function');
      });

      test('request() builds an absolute URL against the app-local origin', async () => {
        const response = await app().request('/echo', { method: 'POST' });
        expect(await response.json()).toEqual({ pathname: '/echo', method: 'POST' });
      });

      test('json() parses the body for the caller', async () => {
        const body = await app().json<{ pathname: string; method: string }>('/echo');
        expect(body).toEqual({ pathname: '/echo', method: 'GET' });
      });

      test('an unmatched path falls through to the fake app', async () => {
        const response = await app().request('/nope');
        expect(response.status).toBe(404);
      });
    },
  );

  test('close() ran once the describe block finished', () => {
    expect(rec.closed).toBe(true);
  });
});

describe(testName('unit', 'describeApp: accessing the handle before boot'), () => {
  let earlyAccessError: unknown;

  describeApp('booted late', { boot: fakeBoot(recorder()) }, (app) => {
    // Runs synchronously while the describe block is being registered, i.e. before beforeAll —
    // exactly the window the accessor's guard exists for.
    try {
      app();
    } catch (error) {
      earlyAccessError = error;
    }

    test('the accessor throws until beforeAll has booted the app', () => {
      expect(earlyAccessError).toBeInstanceOf(ReferenceError);
    });
  });
});

describe(testName('unit', 'describeApp: options wiring'), () => {
  describeApp(
    'deterministic options',
    {
      boot: fakeBoot(recorder()),
      seedValue: 42,
      now: '2030-01-01T00:00:00.000Z',
    },
    (app) => {
      test('now/seedValue are threaded into the installed determinism', () => {
        void app;
        expect(Date.now()).toBe(new Date('2030-01-01T00:00:00.000Z').getTime());
        const expected = seededRandom(42);
        expect(Math.random()).toBe(expected());
        expect(Math.random()).toBe(expected());
      });
    },
  );

  describeApp(
    'an unlisted host stays sealed, an allow-listed one is let through the seal',
    {
      boot: fakeBoot(recorder()),
      // A closed loopback port, so "through the seal" is proved by a local connection refusal
      // instead of real egress: nothing announced this port, so `isSelfOrigin` does not cover it
      // and the allowlist is the only thing that can let the request past.
      allowHosts: [`127.0.0.1:${CLOSED_PORT}`],
    },
    (app) => {
      test('a host nobody allow-listed is refused before it ever dials out', async () => {
        void app;
        expect(await failureCode('https://also-not-allowed.invalid/x')).toBe(
          'X_TEST_NETWORK_SEALED',
        );
      });

      test('an allow-listed host clears the seal — failure is the transport, not the seal', async () => {
        void app;
        const code = await failureCode(`http://127.0.0.1:${CLOSED_PORT}/x`);
        expect(code).toBeDefined();
        expect(code).not.toBe('X_TEST_NETWORK_SEALED');
      });
    },
  );
});

describe(testName('unit', 'testApp'), () => {
  const rec = recorder();

  testApp('boots and closes around a single test', { boot: fakeBoot(rec) }, async (app) => {
    expect(rec.sequence).toEqual(['boot']);
    expect(rec.closed).toBe(false);
    const response = await app.request('/echo');
    expect(response.status).toBe(200);
  });

  test('close() already ran once the isolated test finished', () => {
    expect(rec.closed).toBe(true);
  });
});

// Registered last on purpose: bun runs describes in declaration order, so by the time these run
// every boot above has been torn down. `bun test` is ONE process, so what these assert about this
// file is what the next FILE inherits — an unsealed `fetch` here is real egress there.
describe(testName('unit', 'teardown restores the process state it found'), () => {
  test('the preload owns the seal, and a booted app hands it back sealed', () => {
    expect(SEALED_BEFORE).toBe(true);
    expect(isNetworkSealed()).toBe(true);
  });

  test('the frozen clock and the seeded RNG survive every boot above', () => {
    expect(isDeterminismInstalled()).toBe(true);
    // Not just "frozen": the same instant. A boot declaring `now: '2030-…'` restores the clock it
    // found rather than re-freezing at the default.
    expect(Date.now()).toBe(NOW_BEFORE);
    expect(Math.random).toBe(RANDOM_BEFORE);
  });

  test('the allow-list a boot added is gone again', async () => {
    // `allowHosts` above let 127.0.0.1:59431 through. Nothing may inherit that.
    await expect(fetch(`http://127.0.0.1:${CLOSED_PORT}/x`)).rejects.toBeUltimateError(
      'X_TEST_NETWORK_SEALED',
    );
    expect(requestedUrls()).toContain(`http://127.0.0.1:${CLOSED_PORT}/x`);
  });
});

// A rejecting `close` is the case `describeApp`/`testApp` cannot express: both rethrow it into the
// test's own result, so the assertion has to sit beside the lifecycle itself.
describe(testName('unit', 'a teardown that throws'), () => {
  test('still drops the cloned database and still restores the process state', async () => {
    let dropped = false;
    const booted = await bootApp({
      boot: async () => ({
        fetch: () => new Response('ok'),
        close: async () => {
          throw new Error('the app refused to close');
        },
      }),
    });
    // `acquireWorkerDatabase` answers a PGlite handle with no TEST_DATABASE_URL, whose `drop` is a
    // no-op — so the flag, not the database, is what proves the call was reached.
    const handle = booted.handle as { db: { drop: () => Promise<void> } };
    handle.db.drop = async () => {
      dropped = true;
    };

    await expect(booted.close()).rejects.toThrow('the app refused to close');

    expect(dropped).toBe(true);
    expect(isNetworkSealed()).toBe(true);
    expect(isDeterminismInstalled()).toBe(true);
  });
});

// The mirror image of the block above, and the half the teardown fix left open: a boot that rejects
// hands back no `BootedHarness`, so no caller can ever reach `close()`. Whatever the boot already
// changed — the clone, the allow-list, the clock — is the boot's own to put back, or one
// `ultimate_test_template_wN` leaks per failing seed and the next FILE in the process inherits a
// clock that reads 2031.
describe(testName('unit', 'a boot that throws'), () => {
  /**
   * `acquireWorkerDatabase`'s PGlite fallback answers a handle whose `drop` is a no-op, so the real
   * one can never prove the rejection path called it. Injected for the reason `TemplateDbDeps`
   * injects `connect`: the claim is about the harness, and it needs no server to make.
   */
  const acquireInto = (record: { dropped: boolean }): HarnessDeps['acquire'] => {
    return async () =>
      ({
        kind: 'pglite',
        worker: 0,
        database: 'harness_reject',
        url: 'pglite://memory/harness_reject',
        drop: async () => {
          record.dropped = true;
        },
      }) satisfies WorkerDatabase;
  };

  const NEVER_BOOTS: AppOptions['boot'] = async () => {
    throw new Error('the app refused to boot');
  };

  test('a rejecting seed drops the clone and restores the seal, the clock and the allow-list', async () => {
    const record = { dropped: false };
    const before = Date.now();

    await expect(
      bootApp(
        {
          boot: NEVER_BOOTS,
          seed: async () => {
            throw new Error('the seed hit a constraint');
          },
          allowHosts: [`127.0.0.1:${CLOSED_PORT}`],
          now: '2031-06-01T00:00:00.000Z',
        },
        { acquire: acquireInto(record) },
      ),
      // The seed's own failure, never the drop's and never a wrapper: it is the only line that says
      // what went wrong.
    ).rejects.toThrow('the seed hit a constraint');

    expect(record.dropped).toBe(true);
    expect(isNetworkSealed()).toBe(true);
    expect(isDeterminismInstalled()).toBe(true);
    expect(Date.now()).toBe(before);
    expect(await failureCode(`http://127.0.0.1:${CLOSED_PORT}/x`)).toBe('X_TEST_NETWORK_SEALED');
  });

  test('a rejecting boot drops the clone the seed already ran against', async () => {
    const record = { dropped: false };
    let seededUrl: string | undefined;

    await expect(
      bootApp(
        {
          boot: NEVER_BOOTS,
          seed: async (url) => {
            seededUrl = url;
          },
        },
        { acquire: acquireInto(record) },
      ),
    ).rejects.toThrow('the app refused to boot');

    expect(seededUrl).toBe('pglite://memory/harness_reject');
    expect(record.dropped).toBe(true);
    expect(isNetworkSealed()).toBe(true);
    expect(isDeterminismInstalled()).toBe(true);
  });

  test('a drop that also fails does not replace the reason the boot failed', async () => {
    await expect(
      bootApp(
        { boot: NEVER_BOOTS },
        {
          acquire: async () => ({
            kind: 'pglite',
            worker: 0,
            database: 'harness_reject',
            url: 'pglite://memory/harness_reject',
            drop: async () => {
              throw new Error('the clone would not drop');
            },
          }),
        },
      ),
    ).rejects.toThrow('the app refused to boot');
  });
});
