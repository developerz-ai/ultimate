import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { defineRoute } from './route';
import { metaContextFor, routeDataFor } from './route-data';

const CTX = { params: { id: '7' }, url: 'http://localhost/posts/7' } as const;

const base = {
  render: 'ssr',
  offline: 'network-only',
  hydrate: 'never',
} as const;

describe('routeDataFor', () => {
  test('a route with no load gets the context as its data, exactly as before load existed', async () => {
    const config = defineRoute({ ...base, meta: () => ({ title: 't' }) });
    // Back-compat is the whole point of this branch: routes that shipped read `data.url` and
    // `data.params`, and adding an optional key must not have moved either.
    expect(await routeDataFor(config, CTX)).toEqual(CTX);
  });

  test('a sync load is awaited into the same shape an async one produces', async () => {
    const config = defineRoute({
      ...base,
      load: (ctx) => ({ id: ctx.params['id'] }),
      meta: (data) => ({ title: `post ${data.id}` }),
    });
    expect(await routeDataFor(config, CTX)).toEqual({ id: '7' });
  });

  test('an async load resolves', async () => {
    const config = defineRoute({
      ...base,
      load: async (ctx) => ({ id: ctx.params['id'], loaded: true }),
      meta: () => ({ title: 't' }),
    });
    expect(await routeDataFor(config, CTX)).toEqual({ id: '7', loaded: true });
  });

  test('meta reads the data the loader produced — the reason load exists at all', async () => {
    const config = defineRoute({
      ...base,
      load: () => ({ title: 'Hello world' }),
      meta: (ctx) => ({ title: ctx.data.title }),
    });
    // Resolved ONCE and handed to both. A second resolution here would be the drift this seam
    // exists to prevent: a <title> describing content the body does not contain.
    const data = await routeDataFor(config, CTX);
    expect(await config.meta(metaContextFor(CTX, data))).toEqual({ title: 'Hello world' });
  });

  test('the meta context carries the request and the translator, not just the data', async () => {
    const config = defineRoute({
      ...base,
      load: () => ({ title: 'Hello world' }),
      // Every field a real `<head>` needs: the content, the canonical, and `t` — because no
      // user-facing string may be hardcoded, a <title> included.
      meta: (ctx) => ({
        title: ctx.data.title,
        description: `${ctx.params['id']} @ ${ctx.url} / ${typeof ctx.t}`,
      }),
    });
    const meta = await config.meta(metaContextFor(CTX, await routeDataFor(config, CTX)));
    expect(meta.description).toBe('7 @ http://localhost/posts/7 / function');
  });

  test('a route with no load still sees params and url on the context, as it always did', async () => {
    // The back-compat half of the superset claim: `{ params, url }` was the WHOLE argument before
    // `load` existed, and both keys had to keep their names for shipped routes to survive.
    const config = defineRoute({ ...base, meta: (ctx) => ({ title: ctx.url }) });
    const ctx = metaContextFor(CTX, await routeDataFor(config, CTX));
    expect(ctx.params).toEqual(CTX.params);
    expect(ctx.url).toBe(CTX.url);
    expect(await config.meta(ctx)).toEqual({ title: CTX.url });
  });

  test('a throwing load fails as X_ROUTE_LOAD_FAILED, naming the path an author must fix', async () => {
    const config = defineRoute({
      ...base,
      load: () => {
        throw new Error('the database is asleep');
      },
      meta: () => ({ title: 't' }),
    });
    const failure = await routeDataFor(config, CTX).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UltimateError);
    const error = failure as UltimateError;
    expect(error.code).toBe('X_ROUTE_LOAD_FAILED');
    expect(error.cause).toContain('/posts/7');
    expect(error.cause).toContain('the database is asleep');
    expect(error.fix).toContain('/posts/7');
  });

  test("a loader's own UltimateError survives — its code and fix beat a generic wrapper", async () => {
    // A policy denial or a missing row already knows what went wrong and how to fix it. Burying
    // that under X_ROUTE_LOAD_FAILED would cost the caller both.
    class NotFound extends UltimateError {
      constructor() {
        super({ code: 'X_NOT_FOUND', cause: 'no such post', fix: 'check the id' });
      }
    }
    const config = defineRoute({
      ...base,
      load: () => {
        throw new NotFound();
      },
      meta: () => ({ title: 't' }),
    });
    const failure = await routeDataFor(config, CTX).catch((error: unknown) => error);
    expect((failure as UltimateError).code).toBe('X_NOT_FOUND');
  });

  test('a non-function load is refused at declaration, not at the first request', async () => {
    const declare = () =>
      defineRoute({
        ...base,
        // A JS caller bypassing the types is exactly who this guard is for.
        load: 'not a function' as never,
        meta: () => ({ title: 't' }),
      });
    expect(declare).toThrow(/X_ROUTE_LOAD_INVALID|not a function/);
  });
});
