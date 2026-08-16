import { describe, expect, test } from 'bun:test';
import { agentActor, anonymousActor, userActor } from './actor';
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
