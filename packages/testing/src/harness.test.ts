// Tests describeApp/testApp — the framework's own in-process app-boot harness. A fake `boot`
// stands in for a real server, so this proves the lifecycle contract (seed -> boot -> requests ->
// close) without spinning up a real app. `installDeterminism`/`sealNetwork` are process-global and
// bun shares one process across files, so boot()/close() flipping them for real (not just for this
// file) has to be undone in a trailing `afterAll` — otherwise every file that runs after this one
// loses the frozen clock and the sealed network, a load-order flake rather than a failure.

import { afterAll, describe, expect, test } from 'bun:test';
import { installDeterminism, seededRandom } from './determinism';
import type { AppOptions, BootedApp } from './harness';
import { describeApp, testApp } from './harness';
import { sealNetwork } from './sealed-network';

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

describe('describeApp lifecycle', () => {
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

describe('describeApp: accessing the handle before boot', () => {
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

describe('describeApp: options wiring', () => {
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
      allowHosts: ['never-resolves.invalid'],
    },
    (app) => {
      test('a host nobody allow-listed is refused before it ever dials out', async () => {
        void app;
        try {
          await fetch('https://also-not-allowed.invalid/x');
          throw new Error('expected the sealed network to refuse this');
        } catch (error) {
          expect((error as { code?: string }).code).toBe('X_TEST_NETWORK_SEALED');
        }
      });

      test('an allow-listed host clears the seal — failure is a real network error, not X_TEST_NETWORK_SEALED', async () => {
        void app;
        const code = await fetch('https://never-resolves.invalid/x').then(
          () => undefined,
          (error: unknown) => (error as { code?: string }).code,
        );
        expect(code).not.toBe('X_TEST_NETWORK_SEALED');
      });
    },
  );
});

describe('testApp', () => {
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
