import { describe, expect, test } from 'bun:test';
import { ULTIMATE_ERROR_BRAND, UltimateError } from '@ultimat3/core';
import { defineRoute } from './route';
import { metaContextFor, routeDataFor } from './route-data';

const CTX = { params: { id: '7' }, url: 'http://localhost/posts/7' } as const;

const base = {
  render: 'ssr',
  offline: 'network-only',
  hydrate: 'never',
} as const;

/**
 * What `Bun.file(...).text()` throws for a missing file, and what every `node:fs` call throws:
 * an `Error` carrying a string `code` and NO brand. Deliberately unbranded — that a `code`
 * property is not proof of membership is the whole assertion, so a framework subclass here
 * would test nothing.
 */
function foreignEnoent(): Error {
  return Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
}

/**
 * What a tier-0 package throws. `@ultimat3/schema` cannot import `@ultimat3/core`, so its
 * errors carry the well-known symbol instead of extending the class — a full code, cause and
 * fix, and still never an `instanceof UltimateError`.
 */
function tierZeroFailure(): Error {
  return Object.assign(new Error('expected a string'), {
    [ULTIMATE_ERROR_BRAND]: true,
    code: 'X_VALIDATION_FAILED',
    cause: 'field "title": expected a string, received number',
    fix: 'x actions describe publishPost --json  # compare the value against `input:`',
  });
}

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
      meta: (ctx) => ({ title: `post ${ctx.data.id}` }),
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

  test('a hostile thrown value is rendered, not read — the frame must survive app code', async () => {
    // `load` is APP code and may throw anything. `cause.message` is a property read and
    // `String(cause)` runs the value's own `toString`, so both hazards live on the one line that
    // is supposed to be turning a failure into an instruction. `renderThrowable` is core's total
    // renderer and is what every other last-resort site in the framework uses.
    const hostile = {
      get message(): string {
        throw new TypeError('message getter');
      },
      toString(): string {
        throw new TypeError('toString');
      },
    };
    Object.setPrototypeOf(hostile, Error.prototype);
    const config = defineRoute({
      ...base,
      load: () => {
        throw hostile;
      },
      meta: () => ({ title: 't' }),
    });

    const failure = await routeDataFor(config, CTX).catch((error: unknown) => error);
    expect((failure as UltimateError).code).toBe('X_ROUTE_LOAD_FAILED');
    expect((failure as UltimateError).cause).toContain('/posts/7');
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

  test('an ENOENT is wrapped — a string `code` was never proof the error was ours', async () => {
    // The duck-type this replaced let every one of these straight out of the frame: the reader
    // got a bare ENOENT with no fix line and no mention of the route that failed to load.
    const config = defineRoute({
      ...base,
      load: () => {
        throw foreignEnoent();
      },
      meta: () => ({ title: 't' }),
    });
    const failure = await routeDataFor(config, CTX).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UltimateError);
    const error = failure as UltimateError;
    expect(error.code).toBe('X_ROUTE_LOAD_FAILED');
    expect(error.cause).toContain('/posts/7');
    expect(error.cause).toContain('ENOENT');
    expect(error.fix).toContain('/posts/7');
  });

  test('a tier-0 error survives on its brand alone, not on being a core subclass', async () => {
    // Checking `instanceof UltimateError` here would bury an `X_VALIDATION_FAILED` — the most
    // precise thing a loader can fail with — under a generic wrapper, which is the same loss the
    // ENOENT case is the mirror image of. Identity, not just the code: the contract is that the
    // object arrives untouched, so its cause and fix reach the reader too.
    const thrown = tierZeroFailure();
    const config = defineRoute({
      ...base,
      load: () => {
        throw thrown;
      },
      meta: () => ({ title: 't' }),
    });
    const failure = await routeDataFor(config, CTX).catch((error: unknown) => error);
    expect(failure).toBe(thrown);
    expect((failure as UltimateError).code).toBe('X_VALIDATION_FAILED');
    expect((failure as UltimateError).fix).toContain('x actions describe publishPost');
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

/**
 * `new URL(ctx.url)` was called TWICE inside the catch block, so a relative `ctx.url` — what a
 * test harness, a prerender pass and `x build` all hand this function — replaced the one coded
 * error this frame exists to produce with a bare `TypeError` carrying no fix and no route name.
 */
describe('routeDataFor with a relative ctx.url', () => {
  const relative = { params: { id: '7' }, url: '/posts/7' } as const;

  const throwingRoute = () =>
    defineRoute({
      ...base,
      load: () => {
        throw new Error('the loader failed');
      },
      meta: () => ({ title: 't' }),
    });

  test('a failing load is still X_ROUTE_LOAD_FAILED, not a URIError from the catch block', async () => {
    await expect(routeDataFor(throwingRoute(), relative)).rejects.toMatchObject({
      code: 'X_ROUTE_LOAD_FAILED',
    });
  });

  test('the cause and the fix still name the path the load failed for', async () => {
    await expect(routeDataFor(throwingRoute(), relative)).rejects.toMatchObject({
      cause: expect.stringContaining('/posts/7'),
      fix: expect.stringContaining('/posts/7'),
    });
  });

  test('an absolute url still reports the pathname alone, never the origin', async () => {
    await expect(routeDataFor(throwingRoute(), CTX)).rejects.toMatchObject({
      cause: expect.stringContaining('/posts/7'),
    });
    await expect(routeDataFor(throwingRoute(), CTX)).rejects.not.toMatchObject({
      cause: expect.stringContaining('http://localhost'),
    });
  });

  test('a successful load is untouched by any of this', async () => {
    const config = defineRoute({
      ...base,
      load: (ctx) => ({ id: ctx.params['id'] }),
      meta: () => ({ title: 't' }),
    });
    expect(await routeDataFor(config, relative)).toEqual({ id: '7' });
  });
});
