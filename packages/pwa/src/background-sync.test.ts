// The emitted background-sync block is code nobody type-checks: it leaves this package as a
// string and is next parsed by a browser. So these tests read it the way the browser will —
// parsing and running the class it defines — rather than trusting that it was spelled right.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode } from '@ultimat3/core';
import {
  backgroundSyncSource,
  DEFAULT_FLUSH_ENDPOINT,
  DEFAULT_RETRY,
  registerBackgroundSyncSource,
  retryDelayMs,
  SYNC_TAG,
  shouldRetry,
} from './background-sync';
import { PwaSyncFlushFailedError, PwaSyncIncompleteError } from './errors';

/** The fields the emitted class promises — the same four `UltimateError` exposes, plus `message`. */
interface EmittedSyncError {
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
  readonly docs: string;
  readonly message: string;
}

/**
 * The emitted block, evaluated the way a browser evaluates `sw.js`: `self` and `BUILD_ID` are the
 * two globals the service-worker realm supplies. Constructing the error is the only proof the
 * emitted class works — a substring assertion passes just as happily on source that throws a
 * `SyntaxError` on the first byte the browser reads.
 */
function emittedError(code: string): EmittedSyncError {
  const build = new Function(
    'self',
    'BUILD_ID',
    `${backgroundSyncSource()}
return new PwaSyncError(${JSON.stringify(code)},'the flush endpoint said no','run the fix command');`,
  );
  return build({ addEventListener: () => undefined }, 'build-1') as EmittedSyncError;
}

describe('backgroundSyncSource', () => {
  test('throws no bare Error — every failure in the generated realm is coded', () => {
    const source = backgroundSyncSource();

    expect(source).not.toContain('new Error(');
    expect([...source.matchAll(/throw new (\w+)\(/g)].map((match) => match[1])).toEqual([
      'PwaSyncError',
      'PwaSyncError',
    ]);
  });

  test('each failure throws the code errors.ts declares for it', () => {
    const source = backgroundSyncSource();

    const thrownWith = (code: string): string => `throw new PwaSyncError(${JSON.stringify(code)}`;
    expect(source).toContain(thrownWith(PwaSyncFlushFailedError.code));
    expect(source).toContain(thrownWith(PwaSyncIncompleteError.code));
  });

  test('each failure carries a fix an operator can run, not advice', () => {
    const source = backgroundSyncSource();

    // A rejected flush is reproducible against the endpoint the SW just called.
    expect(source).toContain("'curl -i -X POST '+FLUSH_ENDPOINT");
    // A partial flush is the outbox worker's business, or the retry ceiling's.
    expect(source).toContain('x dev --role sync');
    expect(source).toContain('pwa.backgroundSync.retry.maxAttempts in app.config.ts');
  });

  test('the emitted class exposes code, cause, fix and docs, like every other Ultimate error', () => {
    const error = emittedError(PwaSyncFlushFailedError.code);

    expect(error.code).toBe(PwaSyncFlushFailedError.code);
    expect(error.cause).toBe('the flush endpoint said no');
    expect(error.fix).toBe('run the fix command');
    // The docs host the SW builds its URL from is the one the registry declares here.
    expect(error.docs).toBe(describeErrorCode(PwaSyncFlushFailedError.code).docs);
  });

  test('the message alone still instructs — an uncaught waitUntil rejection prints nothing else', () => {
    const message = emittedError(PwaSyncIncompleteError.code).message;

    expect(message).toContain(PwaSyncIncompleteError.code);
    expect(message).toContain('the flush endpoint said no');
    expect(message).toContain('fix:   run the fix command');
    expect(message).toContain(describeErrorCode(PwaSyncIncompleteError.code).docs);
  });

  test('the handler is keyed on this package own sync tag and the configured endpoint', () => {
    const source = backgroundSyncSource({ flushEndpoint: '/custom/flush' });

    expect(source).toContain(`const SYNC_TAG="${SYNC_TAG}"`);
    expect(source).toContain('const FLUSH_ENDPOINT="/custom/flush"');
    expect(source).not.toContain(DEFAULT_FLUSH_ENDPOINT);
    expect(source).toContain("addEventListener('sync'");
  });

  // Periodic Background Sync is NOT implemented, and this is where that is written down.
  // `PERIODIC_SYNC_TAG` and `BackgroundSyncOptions.periodicMinIntervalMs` existed as declarations
  // with no handler behind them — no `periodicsync` listener is emitted, no `periodicSync.register`
  // is ever called, and `CAPABILITIES` has no `periodicSync` flag to gate one. Both were deleted
  // rather than left as a settable option that changes nothing. `wiki/PWA-And-Offline.md` and
  // `docs/idea/08-pwa-offline.md` still document a `periodicSync` capability; this assertion is
  // what fails if the tag comes back before the handler does.
  test('one-shot sync only — no periodicsync handler is emitted, because none is implemented', () => {
    const source = backgroundSyncSource();
    expect(source).toContain("addEventListener('sync'");
    expect(source).not.toContain('periodicsync');
    expect(source).not.toContain('periodicSync');
    expect(registerBackgroundSyncSource()).not.toContain('periodicSync');
  });

  test('is deterministic for identical input', () => {
    expect(backgroundSyncSource()).toBe(backgroundSyncSource());
    expect(backgroundSyncSource()).not.toContain('Date.now()');
  });
});

/**
 * `flushOutbox`, evaluated and RUN the way the browser runs it. The generated realm supplies
 * `self`, `BUILD_ID` and `fetch`; everything else in the block is its own.
 */
function emittedFlush(reply: () => Response): () => Promise<void> {
  const build = new Function(
    'self',
    'BUILD_ID',
    'fetch',
    `${backgroundSyncSource()}
return flushOutbox;`,
  );
  return build({ addEventListener: () => undefined }, 'build-1', async () =>
    reply(),
  ) as () => Promise<void>;
}

describe('the emitted flushOutbox, executed', () => {
  test('a 200 whose body is the four bytes `null` completes instead of throwing a TypeError', async () => {
    // `res.json()` RESOLVES with `null` here, so the `.catch` never fires and the default object
    // never arrives — `body.remaining` was a TypeError inside `event.waitUntil`, i.e. an unhandled
    // rejection in the service-worker realm in place of the coded refusal this block exists for.
    await emittedFlush(() => new Response('null', { status: 200 }))();
  });

  test('an unparseable body still completes, which is what the default was always for', async () => {
    await emittedFlush(() => new Response('<html>proxy</html>', { status: 200 }))();
  });

  test('a body that reports work left behind is still X_PWA_SYNC_INCOMPLETE', async () => {
    const failure = emittedFlush(
      () => new Response(JSON.stringify({ remaining: 3 }), { status: 200 }),
    )();
    await expect(failure).rejects.toMatchObject({
      code: PwaSyncIncompleteError.code,
      name: 'PwaSyncError',
    });
  });

  test('a non-2xx is still X_PWA_SYNC_FLUSH_FAILED, before the body is read at all', async () => {
    const failure = emittedFlush(() => new Response('null', { status: 503 }))();
    await expect(failure).rejects.toMatchObject({
      code: PwaSyncFlushFailedError.code,
      name: 'PwaSyncError',
    });
  });
});

describe('retryDelayMs', () => {
  test('doubles per attempt and stops at the ceiling', () => {
    expect(retryDelayMs(1)).toBe(DEFAULT_RETRY.baseDelayMs);
    expect(retryDelayMs(3)).toBe(DEFAULT_RETRY.baseDelayMs * 4);
    expect(retryDelayMs(DEFAULT_RETRY.maxAttempts)).toBeLessThanOrEqual(DEFAULT_RETRY.maxDelayMs);
  });

  test('an attempt below one or past the ceiling is clamped, never negative or unbounded', () => {
    expect(retryDelayMs(0)).toBe(DEFAULT_RETRY.baseDelayMs);
    expect(retryDelayMs(99)).toBe(retryDelayMs(DEFAULT_RETRY.maxAttempts));
  });
});

describe('shouldRetry', () => {
  test('stops at the attempt ceiling', () => {
    expect(shouldRetry(DEFAULT_RETRY.maxAttempts - 1)).toBe(true);
    expect(shouldRetry(DEFAULT_RETRY.maxAttempts)).toBe(false);
  });
});

/**
 * The emitted realm's class and the `UltimateError` subclass that owns the code are two
 * declarations of one contract, in two languages the compiler never compares. So both are
 * constructed with the same cause and fix and read field for field.
 */
describe('the emitted class and the class errors.ts owns', () => {
  test.each([
    ['flush failed', PwaSyncFlushFailedError],
    ['incomplete', PwaSyncIncompleteError],
  ] as const)('agree on code, cause, fix and docs — %s', (_name, ErrorClass) => {
    const cause = 'the flush endpoint said no';
    const fix = 'run the fix command';
    const owned = new ErrorClass(cause, fix);
    const emitted = emittedError(ErrorClass.code);

    expect(owned.code).toBe(ErrorClass.code);
    expect({
      code: emitted.code,
      cause: emitted.cause,
      fix: emitted.fix,
      docs: emitted.docs,
    }).toEqual({ code: owned.code, cause: owned.cause, fix: owned.fix, docs: owned.docs });
    expect(owned.title).toBe(describeErrorCode(ErrorClass.code).title);
  });
});

/**
 * `registerBackgroundSyncSource` is client code emitted as a string, so it is executed rather than
 * read. The fallback branch is the one that matters: without it, every browser without Background
 * Sync keeps its outbox forever and the user's mutations never leave the device.
 */
describe('registerBackgroundSyncSource, executed', () => {
  interface Realm {
    readonly registered: string[];
    readonly online: (() => void)[];
    readonly posted: unknown[];
    register(registration: unknown): Promise<string>;
  }

  function realm(): Realm {
    const registered: string[] = [];
    const online: (() => void)[] = [];
    const posted: unknown[] = [];
    const source = registerBackgroundSyncSource();
    expect(source.startsWith('export async function registerOutboxSync')).toBe(true);

    const run = new Function(
      'addEventListener',
      'navigator',
      'registration',
      `${source.replace('export async function', 'async function')}
return registerOutboxSync(registration);`,
    ) as (
      addEventListener: (type: string, handler: () => void) => void,
      navigator: unknown,
      registration: unknown,
    ) => Promise<string>;

    return {
      registered,
      online,
      posted,
      register: (registration) =>
        run(
          (type, handler) => {
            if (type === 'online') online.push(handler);
          },
          {
            serviceWorker: {
              controller: {
                postMessage: (message: unknown): void => {
                  posted.push(message);
                },
              },
            },
          },
          registration,
        ),
    };
  }

  test('registers this package own sync tag when the platform has Background Sync', async () => {
    const sw = realm();
    const outcome = await sw.register({
      sync: {
        register: async (tag: string): Promise<void> => {
          sw.registered.push(tag);
        },
      },
    });

    expect(outcome).toBe('sync');
    expect(sw.registered).toEqual([SYNC_TAG]);
    expect(sw.online).toHaveLength(0);
  });

  test('falls back to an online listener that asks the controller to flush', async () => {
    const sw = realm();
    const outcome = await sw.register({});

    expect(outcome).toBe('fallback');
    expect(sw.registered).toEqual([]);
    expect(sw.online).toHaveLength(1);

    sw.online[0]?.();
    expect(sw.posted).toEqual([{ type: 'flush-outbox' }]);
  });

  test('a sync object without register() is not Background Sync', async () => {
    const sw = realm();
    expect(await sw.register({ sync: {} })).toBe('fallback');
    expect(sw.registered).toEqual([]);
  });
});
