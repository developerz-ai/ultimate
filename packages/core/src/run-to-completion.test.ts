// `runToCompletion`: the one scope in which work that was cancelled is still allowed to finish, and
// `abandonment`: the question every write path asks. A coded reason means somebody was already
// answered; an uncoded one (Bun's `AbortError` on a client hang-up) means nobody was told anything.

import { afterEach, describe, expect, test } from 'bun:test';
import { anonymousActor } from './actor';
import {
  abandonment,
  ctxOf,
  runToCompletion,
  runWithContext,
  throwIfAborted,
  useContext,
} from './context';
import { UltimateError } from './errors';
import { retry } from './retry';
import { defineService, resetServices } from './service';

afterEach(() => resetServices());

const coded = (): UltimateError =>
  new UltimateError({ code: 'X_TIMEOUT', cause: 'past the deadline', fix: 'raise it' });

const abortedWith = (reason: unknown): AbortSignal => {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
};

describe('abandonment', () => {
  test('answers the same object the signal was aborted with, when it is coded', () => {
    const reason = coded();
    const ctx = ctxOf({ signal: abortedWith(reason) });
    expect(runWithContext(ctx, () => abandonment())).toBe(reason);
  });

  test('a client hang-up is not abandonment: an uncoded reason answers undefined', () => {
    const hangUp = new DOMException('The operation was aborted.', 'AbortError');
    const ctx = ctxOf({ signal: abortedWith(hangUp) });
    expect(runWithContext(ctx, () => abandonment())).toBeUndefined();
  });

  test('a live signal and no context both answer undefined', () => {
    expect(abandonment()).toBeUndefined();
    expect(runWithContext(ctxOf(), () => abandonment())).toBeUndefined();
  });
});

describe('runToCompletion', () => {
  const parent = (): ReturnType<typeof ctxOf> =>
    ctxOf({
      requestId: 'req-1',
      actor: { ...anonymousActor(), id: 'u-1', kind: 'user' },
      signal: abortedWith(coded()),
      deadlineAt: 1_000,
    });

  test('under an aborted parent the signal is live, the deadline gone, throwIfAborted passes', () => {
    runWithContext(parent(), () => {
      expect(useContext().signal.aborted).toBe(true);
      runToCompletion(() => {
        const ctx = useContext();
        expect(ctx.signal.aborted).toBe(false);
        expect(ctx.deadlineAt).toBeNull();
        expect(abandonment()).toBeUndefined();
        expect(() => throwIfAborted()).not.toThrow();
      });
      // The scope ends with `fn`: the caller's own cancellation stands.
      expect(useContext().signal.aborted).toBe(true);
    });
  });

  test('keeps who is asking and which request this is', () => {
    const ctx = parent();
    runWithContext(ctx, () => {
      runToCompletion(() => {
        expect(useContext().requestId).toBe('req-1');
        expect(useContext().traceId).toBe(ctx.traceId);
        expect(useContext().actor.id).toBe('u-1');
      });
    });
  });

  test('a managed service is rebuilt over the fresh signal; a hand-built one is carried', () => {
    defineService('probe', (facts) => ({ aborted: () => facts.signal.aborted }));
    const handBuilt = { mock: true };
    const ctx = ctxOf({
      requestId: 'req-2',
      signal: abortedWith(coded()),
      services: { handBuilt },
    });
    runWithContext(ctx, () => {
      const seen = (useContext().services['probe'] as { aborted(): boolean }).aborted();
      expect(seen).toBe(true);
      runToCompletion(() => {
        const inner = useContext().services;
        expect((inner['probe'] as { aborted(): boolean }).aborted()).toBe(false);
        expect(inner['handBuilt']).toBe(handBuilt);
      });
    });
  });

  test('retry() inside runs every attempt', async () => {
    let attempts = 0;
    const value = await runWithContext(parent(), () =>
      runToCompletion(() =>
        retry(
          async () => {
            attempts += 1;
            // The cooperative check a retried body makes: under the parent's signal it stops at
            // the first attempt with a terminal `X_ABORTED`.
            throwIfAborted();
            if (attempts < 3) throw coded();
            return 'done';
          },
          { attempts: 3, base: 0, max: 0, jitter: 'none' },
          { sleep: () => Promise.resolve() },
        ),
      ),
    );
    expect(value).toBe('done');
    expect(attempts).toBe(3);
  });

  test('outside a context it just runs fn', () => {
    expect(runToCompletion(() => 7)).toBe(7);
  });

  test('returns what fn returns, and hands a rejection back untouched', async () => {
    const failure = new RangeError('its own');
    const ran = runWithContext(parent(), () => runToCompletion(() => Promise.reject(failure)));
    await expect(ran).rejects.toBe(failure);
  });

  describe('over a wider, mutable context (a request)', () => {
    const wider = () => {
      const base = parent();
      const request = {
        ...base,
        services: base.services,
        requestHeaders: new Headers({ 'user-agent': 'probe' }),
        redirect: undefined as string | undefined,
      };
      return request;
    };
    const ambient = () => useContext() as unknown as ReturnType<typeof wider>;

    test('every field the wider shape adds is there, and the lifetime is still fresh', () => {
      runWithContext(wider(), () => {
        runToCompletion(() => {
          expect(ambient().requestHeaders.get('user-agent')).toBe('probe');
          expect(useContext().signal.aborted).toBe(false);
          expect(useContext().deadlineAt).toBeNull();
          expect(abandonment()).toBeUndefined();
        });
      });
    });

    test('a slot written inside is read back on the original', () => {
      const request = wider();
      runWithContext(request, () => {
        runToCompletion(() => {
          ambient().redirect = '/feed';
        });
      });
      expect(request.redirect).toBe('/feed');
    });

    test('a slot written outside is seen inside', () => {
      const request = wider();
      runWithContext(request, () => {
        request.redirect = '/late';
        runToCompletion(() => expect(ambient().redirect).toBe('/late'));
      });
    });

    test('a managed service is rebuilt over the fresh signal; a framework field never shadowed', () => {
      defineService('probe', (facts) => ({ aborted: () => facts.signal.aborted }));
      defineService('requestHeaders', () => 'a service with a framework name');
      const base = ctxOf({ requestId: 'req-3', signal: abortedWith(coded()) });
      const request = { ...base, services: base.services, requestHeaders: new Headers() };
      runWithContext(request, () => {
        runToCompletion(() => {
          const inner = useContext();
          expect((inner.services['probe'] as { aborted(): boolean }).aborted()).toBe(false);
          expect((inner['probe'] as { aborted(): boolean }).aborted()).toBe(false);
          expect(inner['requestHeaders']).toBeInstanceOf(Headers);
        });
      });
    });
  });

  describe('with a bound the caller owns', () => {
    test('its signal and deadline are the scope, and a coded abort is abandonment again', () => {
      const ceiling = new AbortController();
      const reason = coded();
      runWithContext(parent(), () => {
        runToCompletion(
          () => {
            expect(useContext().deadlineAt).toBe(5_000);
            expect(abandonment()).toBeUndefined();
            ceiling.abort(reason);
            expect(abandonment()).toBe(reason);
          },
          { signal: ceiling.signal, deadlineAt: 5_000 },
        );
      });
    });

    test('a non-finite deadline is refused, as everywhere', () => {
      runWithContext(parent(), () => {
        expect(() => runToCompletion(() => 1, { deadlineAt: Number.NaN })).toThrow();
      });
    });
  });
});
