// A fake `boot` proves the harness lifecycle contract without a real server behind it. The
// determinism and seal it installs are process-global and bun shares one process across files, so
// the trailing `afterAll` puts them back: without it every file loaded after this one silently
// loses its frozen clock and sealed network — a load-order flake, not a failure.

import { afterAll, describe, expect, test } from 'bun:test';
import { installDeterminism, seededRandom } from './determinism';
import type { AppOptions, BootedApp } from './harness';
import { describeApp, testApp } from './harness';
import { sealNetwork } from './sealed-network';
import { testName } from './test-types';

afterAll(() => {
  installDeterminism();
  sealNetwork();
});

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
