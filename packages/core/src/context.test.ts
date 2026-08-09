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

    expect(observed).toEqual(['b', 'c', 'a']);
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
