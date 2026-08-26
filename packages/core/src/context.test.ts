import { describe, expect, test } from 'bun:test';
import { agentActor, anonymousActor, userActor } from './actor';
import { frozenClock } from './clock';
import {
  createContext,
  hasContext,
  runWithContext,
  throwIfAborted,
  tryUseContext,
  useContext,
  useService,
  withChildContext,
} from './context';
import { createLogger } from './logger';
import { remainingBudgetMs } from './request-budget';

describe('request context', () => {
  test('throws X_NO_CONTEXT outside a request', () => {
    expect(hasContext()).toBe(false);
    expect(tryUseContext()).toBeUndefined();
    expect(() => useContext()).toThrow(/X_NO_CONTEXT/);
  });

  test('stays isolated across concurrent async tasks', async () => {
    const observed: string[] = [];

    async function handle(actorId: string, delayMs: number): Promise<string> {
      const ctx = createContext({ actor: userActor({ id: actorId }), locale: `x-${actorId}` });
      return runWithContext(ctx, async () => {
        await Bun.sleep(delayMs);
        // Interleaved on purpose: a leak between tasks shows up right here.
        observed.push(useContext().actor.id);
        await Bun.sleep(delayMs);
        expect(useContext().locale).toBe(`x-${actorId}`);
        return useContext().requestId;
      });
    }

    const [first, second, third] = await Promise.all([
      handle('a', 30),
      handle('b', 5),
      handle('c', 15),
    ]);

    // The SET, not the sequence. Each task pushes the id its OWN ambient context reports, so a
    // leak between tasks shows up as a duplicate or a wrong id here either way — while asserting
    // the completion ORDER asserted that a 5ms sleep always resolves before a 15ms one, which is
    // false on a loaded machine and is the one flaky test in this repo (seen across three PRs
    // before it was caught: `bun run x -- test unit` failing one shard, then passing on retry).
    // The preload freezes `Date` and seeds `Math.random`, but `Bun.sleep` is a real timer.
    expect([...observed].sort()).toEqual(['a', 'b', 'c']);
    expect(new Set([first, second, third]).size).toBe(3);
    expect(hasContext()).toBe(false);
  });

  test('child contexts inherit, override, and keep the request id', () => {
    const ctx = createContext({ actor: anonymousActor(), locale: 'en', tz: 'UTC' });
    runWithContext(ctx, () => {
      withChildContext({ actor: agentActor({ id: 'mcp-1', scopes: ['post:publish'] }) }, () => {
        const child = useContext();
        expect(child.requestId).toBe(ctx.requestId);
        expect(child.traceId).toBe(ctx.traceId);
        expect(child.actor.kind).toBe('agent');
        expect(child.locale).toBe('en');
      });
      expect(useContext().actor.kind).toBe('anonymous');
    });
  });

  test('ctx.logger carries requestId and traceId on every line', () => {
    const lines: string[] = [];
    const ctx = createContext({
      logger: createLogger({ level: 'info', writer: (line) => lines.push(line) }),
    });
    runWithContext(ctx, () => {
      ctx.logger.info('published', { postId: 'p1' });
    });
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry['requestId']).toBe(ctx.requestId);
    expect(entry['traceId']).toBe(ctx.traceId);
    expect(entry['postId']).toBe('p1');
  });

  test('services resolve by name and fail loudly when absent', () => {
    const ctx = createContext({ services: { mail: { send: () => true } } });
    runWithContext(ctx, () => {
      expect(useService<{ send: () => boolean }>('mail').send()).toBe(true);
      expect(() => useService('posts')).toThrow(/X_SERVICE_MISSING/);
    });
  });

  test('a service is reachable as ctx.<name>, which is what CtxServices augments', () => {
    // `interface CtxServices { posts: PostsService }` types `ctx.posts`; if the service were only
    // under `ctx.services`, every augmenting app would read `undefined` through a typed property.
    const posts = { byId: () => 'p1' };
    const ctx = createContext({ services: { posts } });
    expect((ctx as unknown as { posts: unknown }).posts).toBe(posts);
    expect(ctx.services['posts']).toBe(posts);
  });

  test('a service the boot never installed is undefined on ctx, X_SERVICE_MISSING through useService', () => {
    // Pins the comment on the `...services` spread. `ctx` is a frozen plain object, not a
    // get-trap proxy, so a `CtxServices`-declared service that boot never passed reads
    // `undefined` and its first call is a bare TypeError. Only `useService()` names it.
    const ctx = createContext({ services: { mail: { send: () => true } } });
    const posts = ctx as unknown as { posts?: { byId(): string } };
    expect(posts.posts).toBeUndefined();
    expect(() => (posts as { posts: { byId(): string } }).posts.byId()).toThrow(TypeError);
    runWithContext(ctx, () => {
      expect(() => useService('posts')).toThrow(/X_SERVICE_MISSING/);
    });
  });

  test('useService refuses a prototype member rather than handing back Object.prototype', () => {
    // `useService(row.serviceKey)` travels as data. A raw index on a `{}`-prototyped object is
    // never `undefined` for these names, so the guard above it could not see them and the
    // caller's first method call was a bare TypeError several frames away.
    const ctx = createContext({ services: { mail: { send: () => true } } });
    runWithContext(ctx, () => {
      for (const name of [
        'constructor',
        'toString',
        'valueOf',
        'hasOwnProperty',
        'isPrototypeOf',
        'propertyIsEnumerable',
        'toLocaleString',
        '__proto__',
      ]) {
        expect(() => useService(name)).toThrow(/X_SERVICE_MISSING/);
      }
    });
  });

  test('a service explicitly installed under a prototype name still resolves', () => {
    // The refusal above must be about OWNERSHIP, not about the name: an app that installs a
    // service called `constructor` gets it back.
    const service = { send: () => true };
    const ctx = createContext({ services: { constructor: service } });
    runWithContext(ctx, () => {
      // The type argument is the caller's, exactly as app code writes it: `useService<T>` has no
      // inference site, so leaving it off resolves `T` to `unknown` and the comparison below has
      // nothing to compare against.
      expect(useService<typeof service>('constructor')).toBe(service);
    });
  });

  test('a service may not shadow a context field', () => {
    // An app is free to call a service `logger`; the context's own logger still wins, and the
    // service stays reachable by name. Otherwise naming a service would change what `ctx` means.
    const ctx = createContext({ services: { logger: 'not-a-logger', actor: 'not-an-actor' } });
    expect(typeof ctx.logger.info).toBe('function');
    expect(ctx.actor.kind).toBe('anonymous');
    expect(ctx.services['logger']).toBe('not-a-logger');
  });

  test('throwIfAborted surfaces caller disconnects as X_ABORTED', () => {
    const controller = new AbortController();
    const ctx = createContext({ signal: controller.signal });
    runWithContext(ctx, () => {
      expect(() => throwIfAborted()).not.toThrow();
      controller.abort();
      expect(() => throwIfAborted()).toThrow(/X_ABORTED/);
    });
  });
});

describe('request-scoped log fields', () => {
  const lineOf = (fn: () => void): Record<string, unknown> => {
    const lines: string[] = [];
    const log = createLogger({ writer: (line) => lines.push(line) });
    runWithContext(
      createContext({
        actor: userActor({ id: 'u-1', orgId: 'org-3' }),
        logger: log,
        role: 'worker',
      }),
      () => {
        useContext().logger.info('event');
        fn();
      },
    );
    return JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
  };

  test('an incident query can scope to a tenant without the app threading it', () => {
    const line = lineOf(() => undefined);
    expect(line['orgId']).toBe('org-3');
    expect(line['actorId']).toBe('u-1');
    expect(line['actorKind']).toBe('user');
    expect(line['role']).toBe('worker');
    expect(line['requestId']).toBeString();
    expect(line['traceId']).toBeString();
  });

  test('carries nothing PII-bearing — no email, no name, no token', () => {
    const line = lineOf(() => undefined);
    expect(Object.keys(line).sort()).toEqual([
      'actorId',
      'actorKind',
      'level',
      'msg',
      'orgId',
      'requestId',
      'role',
      'traceId',
      'ts',
    ]);
  });

  test('omits orgId for an actor that has none, rather than logging undefined', () => {
    const lines: string[] = [];
    const log = createLogger({ writer: (line) => lines.push(line) });
    runWithContext(createContext({ actor: anonymousActor(), logger: log }), () => {
      useContext().logger.info('event');
    });
    expect(JSON.parse(lines[0] ?? '{}')).not.toHaveProperty('orgId');
  });
});

/**
 * The browser-bundle guard for the whole package — including this module — lives in
 * `async-context.test.ts`, beside the seam that owns the defect. What is asserted here is the
 * half that seam must not have changed: the server.
 */
describe('the server path is unchanged by the lazy storage', () => {
  test('resolves the same context object inside the scope, and none outside it', () => {
    const ctx = createContext({ locale: 'de-DE' });
    expect(hasContext()).toBe(false);
    const seen = runWithContext(ctx, () => {
      expect(hasContext()).toBe(true);
      return useContext();
    });
    expect(seen).toBe(ctx);
    expect(hasContext()).toBe(false);
    expect(tryUseContext()).toBeUndefined();
  });

  test('propagates across an await, which is the whole reason for AsyncLocalStorage', async () => {
    const ctx = createContext({ locale: 'fr-FR' });
    await runWithContext(ctx, async () => {
      await Bun.sleep(1);
      expect(useContext().locale).toBe('fr-FR');
    });
  });
});

/**
 * One request, one budget. The comment above `withChildContext`'s `deadlineAt` said a patch may
 * only SHORTEN it and the code was `patch.deadlineAt ?? parent.deadlineAt` — no `Math.min` — so a
 * one-second request budget became a one-hour one inside a child scope, and `remainingBudgetMs`
 * put the extended figure on `x-request-timeout-ms` for the next hop to honour.
 */
describe('a child scope inherits the deadline and can only shorten it', () => {
  const at = (ms: number): number => Date.parse('2026-01-01T00:00:00.000Z') + ms;

  const childDeadline = (
    parentAt: number | undefined,
    patchAt: number | undefined,
  ): number | null =>
    runWithContext(createContext(parentAt === undefined ? {} : { deadlineAt: parentAt }), () =>
      withChildContext(patchAt === undefined ? {} : { deadlineAt: patchAt }, () => {
        return useContext().deadlineAt;
      }),
    );

  test('a patch that tries to LENGTHEN the budget is clamped to the parent', () => {
    expect(childDeadline(at(1_000), at(3_600_000))).toBe(at(1_000));
  });

  test('a patch that shortens it wins — a step with its own budget', () => {
    expect(childDeadline(at(1_000), at(250))).toBe(at(250));
  });

  test('no patch inherits the parent', () => {
    expect(childDeadline(at(1_000), undefined)).toBe(at(1_000));
  });

  test('no parent bound means the patch is the only bound', () => {
    expect(childDeadline(undefined, at(500))).toBe(at(500));
  });

  test('neither side bounded stays unbounded', () => {
    expect(childDeadline(undefined, undefined)).toBeNull();
  });

  // A FROZEN clock, not `Date.now()`. The parent's budget here is 1,000ms, so a real clock gives
  // the assertion a one-second window: pause for longer than that between building the context and
  // reading the budget — eight test workers on a loaded runner will — and `remainingBudgetMs`
  // answers `undefined` for an EXPIRED deadline, failing a test that is about clamping. A frozen
  // clock cannot expire, so the only thing left that can fail it is the thing it is testing.
  test('the header the next hop reads carries the clamped budget, not the extended one', () => {
    const clock = frozenClock('2026-08-24T10:00:00.000Z');
    const now = clock.now().getTime();
    runWithContext(createContext({ clock, deadlineAt: now + 1_000 }), () => {
      withChildContext({ deadlineAt: now + 3_600_000 }, () => {
        const left = remainingBudgetMs(useContext());
        expect(left).toBeDefined();
        expect(left ?? 0).toBeLessThanOrEqual(1_000);
      });
    });
  });

  // The defect this whole PR is about, in the file that derives a deadline. `Math.min` PROPAGATES
  // NaN, so ONE non-finite side poisons the child too; `remainingBudgetMs` then asks `left >= 1`,
  // gets false, and answers `undefined` — indistinguishable from "no deadline set". The budget
  // header vanishes and the next hop silently uses its own timeout.
  test('a non-finite deadline is refused at the boundary, never propagated by Math.min', () => {
    expect(() => createContext({ deadlineAt: Number.NaN })).toThrow('deadlineAt');
    expect(() => createContext({ deadlineAt: Number.POSITIVE_INFINITY })).toThrow('deadlineAt');

    const clock = frozenClock('2026-08-24T10:00:00.000Z');
    const parent = createContext({ clock, deadlineAt: clock.now().getTime() + 1_000 });
    runWithContext(parent, () => {
      expect(() => withChildContext({ deadlineAt: Number.NaN }, () => undefined)).toThrow(
        'deadlineAt',
      );
    });
  });

  // The guard must not have eaten the legitimate case: no deadline at all is still no deadline,
  // and that is the ONE nullish value `screenDeadline` is allowed to pass through.
  test('an absent deadline is still absent, and still means unbounded', () => {
    expect(createContext({}).deadlineAt).toBeNull();
    expect(remainingBudgetMs(createContext({}))).toBeUndefined();
  });
});
