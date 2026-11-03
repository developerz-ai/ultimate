// The request context is built once and read everywhere through core's ALS, so a wrong value
// here has no call site to blame it on — it is simply wrong in every handler. These tests pin
// what creation resolves and that the ALS hands the same object back, rather than a copy that
// drifts from what the pipeline decided.

import { describe, expect, test } from 'bun:test';
import {
  anonymousActor,
  ctxOf,
  defineService,
  isAnonymous,
  resetServices,
  runWithContext,
  useContext,
  userActor,
  uuidV7,
} from '@ultimat3/core';
import { localeConfig } from '@ultimat3/i18n';
import { timeConfig } from '@ultimat3/time';
import { defineHttpConfig } from './config';
import {
  actorView,
  asCtx,
  elapsedMs,
  requestContext,
  useRequestContext,
  useRequestCookie,
  useRequestHeader,
  useRequestHeaders,
  withAnonymousRequest,
} from './context';
import { setRedirect, takeRedirect } from './redirect';

const config = defineHttpConfig({
  rateLimit: { scope: 'process' },
});

describe('requestContext', () => {
  test('builds the defaults for a plain https request', () => {
    const ctx = requestContext({
      url: new URL('https://example.com/x'),
      method: 'get',
      role: 'web',
      config,
    });

    expect(ctx.method).toBe('GET');
    expect(ctx.https).toBe(true);
    expect(isAnonymous(ctx.actor)).toBe(true);
    expect(ctx.actor).toEqual(anonymousActor());
    expect(ctx.locale).toBe(localeConfig().fallback);
    expect(ctx.tz).toBe(timeConfig().defaultZone);
    expect(ctx.params).toEqual({});
    expect(ctx.route).toBeUndefined();
    // Core's meaning: the build this PROCESS serves. The CLIENT's claim is `clientBuildId`.
    expect(ctx.buildId).toBe('dev');
    expect(ctx.clientBuildId).toBeNull();
    expect(ctx.input).toBeUndefined();
    expect(ctx.authz).toBeUndefined();
    expect(ctx.rateLimit).toBeUndefined();
    expect(ctx.cache).toBeUndefined();
    expect(ctx.response).toBeUndefined();
    expect(ctx.error).toBeUndefined();
    expect(ctx.requestId.length).toBeGreaterThan(0);
    expect(ctx.traceId.length).toBeGreaterThan(0);
  });

  test('honors an explicit requestId and traceId', () => {
    const ctx = requestContext({
      url: new URL('https://example.com/x'),
      method: 'get',
      role: 'web',
      config,
      requestId: 'req-fixed',
      traceId: 'trace-fixed',
    });
    expect(ctx.requestId).toBe('req-fixed');
    expect(ctx.traceId).toBe('trace-fixed');
  });

  test('generates a fresh id per call when none is passed', () => {
    const a = requestContext({
      url: new URL('https://example.com/x'),
      method: 'get',
      role: 'web',
      config,
    });
    const b = requestContext({
      url: new URL('https://example.com/x'),
      method: 'get',
      role: 'web',
      config,
    });
    expect(a.requestId).not.toBe(b.requestId);
    expect(a.traceId).not.toBe(b.traceId);
  });

  test('infers https from a plain http url', () => {
    const ctx = requestContext({
      url: new URL('http://example.com/x'),
      method: 'get',
      role: 'web',
      config,
    });
    expect(ctx.https).toBe(false);
  });

  test('init.https overrides url-protocol inference', () => {
    const ctx = requestContext({
      url: new URL('https://example.com/x'),
      method: 'get',
      role: 'web',
      config,
      https: false,
    });
    expect(ctx.https).toBe(false);
  });
});

describe('asCtx', () => {
  test('is an identity cast', () => {
    const ctx = requestContext({
      url: new URL('https://example.com/x'),
      method: 'get',
      role: 'web',
      config,
    });
    expect(Object.is(asCtx(ctx), ctx)).toBe(true);
  });
});

describe('useRequestContext', () => {
  test('throws outside any ambient context', () => {
    expect(() => useRequestContext()).toThrow();
  });

  test('round-trips the same context object through the ALS', () => {
    const ctx = requestContext({
      url: new URL('https://example.com/x'),
      method: 'get',
      role: 'web',
      config,
    });
    const result = runWithContext(asCtx(ctx), () => useRequestContext());
    expect(Object.is(result, ctx)).toBe(true);
  });

  // A job, a task, a scheduler round and a CLI command all supply core's `Ctx` — none of them a
  // `RequestContext`. The unchecked cast handed those back with `undefined` in non-optional
  // fields, so the first reader failed as a bare `TypeError` from a PUBLIC API.
  test('refuses a context that is not an HTTP request, with an instruction', () => {
    const jobCtx = ctxOf({});

    expect(() => runWithContext(jobCtx, () => useRequestContext())).toThrow(/X_NO_REQUEST/);
    expect(() => runWithContext(jobCtx, () => useRequestContext().requestHeaders.get('cookie'))) //
      .not.toThrow(TypeError);
  });

  test('names what the caller was after in the refusal', () => {
    const jobCtx = ctxOf({});

    expect(() => runWithContext(jobCtx, () => useRequestContext('the session cookie'))).toThrow(
      /the session cookie was read outside an HTTP request/,
    );
  });
});

// Before these, `RequestContext` held the RESPONSE headers and no reference to the request at
// all — so an action could set a session cookie and nothing in the framework could ever read it
// back. Sign-in worked, and "signed in as X" was unreachable.
describe('the inbound headers on the context', () => {
  const withHeaders = (headers: HeadersInit) =>
    requestContext({
      url: new URL('https://example.com/x'),
      method: 'get',
      role: 'web',
      config,
      requestHeaders: headers,
    });

  test('a context built without them carries an empty Headers, never undefined', () => {
    const ctx = requestContext({
      url: new URL('https://example.com/x'),
      method: 'get',
      role: 'web',
      config,
    });
    expect(ctx.requestHeaders).toBeInstanceOf(Headers);
    expect(ctx.requestHeaders.get('cookie')).toBeNull();
  });

  test('useRequestHeader reads what the caller sent', () => {
    const ctx = withHeaders({ 'x-demo': 'yes' });
    expect(runWithContext(asCtx(ctx), () => useRequestHeader('X-Demo'))).toBe('yes');
    expect(runWithContext(asCtx(ctx), () => useRequestHeader('x-absent'))).toBeNull();
  });

  test('useRequestCookie decodes one cookie out of the header', () => {
    const ctx = withHeaders({ cookie: 'x-locale=de; session=abc%20def; other=1' });
    expect(runWithContext(asCtx(ctx), () => useRequestCookie('session'))).toBe('abc def');
    expect(runWithContext(asCtx(ctx), () => useRequestCookie('x-locale'))).toBe('de');
    expect(runWithContext(asCtx(ctx), () => useRequestCookie('absent'))).toBeNull();
  });

  test('a cookie missing from a real request reads null, not a throw', () => {
    const ctx = withHeaders({});
    expect(runWithContext(asCtx(ctx), () => useRequestCookie('session'))).toBeNull();
  });

  // "no request here" and "the caller sent no cookie" are different facts. Folding them into
  // one `null` is how a job would quietly run as nobody.
  test('X_NO_REQUEST inside a context that is not a request', () => {
    expect(() =>
      runWithContext(ctxOf({ role: 'worker' }), () => useRequestCookie('session')),
    ).toThrow('X_NO_REQUEST');
    expect(() => runWithContext(ctxOf({ role: 'worker' }), () => useRequestHeaders())).toThrow(
      'X_NO_REQUEST',
    );
  });

  test('X_NO_CONTEXT outside any context at all — core answers that one', () => {
    expect(() => useRequestHeader('cookie')).toThrow('X_NO_CONTEXT');
  });
});

// What an `isr` or `static` document renders in. Still a request, so a redirect and a header read
// work; nobody's request, so nothing in it can name the visitor who happened to fill the store.
describe('withAnonymousRequest', () => {
  const ALICE = userActor({ id: 'alice' });
  const signedIn = (services?: Record<string, unknown>) => {
    const ctx = requestContext({
      url: new URL('https://example.com/x'),
      method: 'get',
      role: 'web',
      config,
      requestHeaders: {
        cookie: 'session=abc',
        authorization: 'Bearer t',
        'x-api-key': 'k',
        'proxy-authorization': 'Basic p',
        'x-forwarded-email': 'alice@example.com',
        'accept-language': 'es',
        host: 'evil.test',
      },
      ip: '203.0.113.9',
      peer: { id: 'p', spiffeId: null, subject: null, uriSans: [], dnsSans: [], by: null },
      ...(services === undefined ? {} : { services }),
    });
    ctx.actor = ALICE;
    return ctx;
  };

  test('the actor and every inbound header are gone; the outer context keeps them', () => {
    const ctx = signedIn();
    withAnonymousRequest(ctx, ctx.url, (scope) => {
      expect(isAnonymous(scope.actor)).toBe(true);
      expect(isAnonymous(useContext().actor)).toBe(true);
      expect(useRequestCookie('session')).toBeNull();
      for (const name of [
        'authorization',
        'x-api-key',
        'proxy-authorization',
        'x-forwarded-email',
        'accept-language',
        'host',
      ]) {
        expect(useRequestHeader(name)).toBeNull();
      }
      expect([...scope.requestHeaders.keys()]).toEqual([]);
    });
    // The pipeline still knows who asked: it answers her privately.
    expect(ctx.actor).toBe(ALICE);
    expect(ctx.requestHeaders.get('cookie')).toBe('session=abc');
  });

  test('the visitor-derived slots are empty, the zone is the default, the locale stays keyed', () => {
    const ctx = signedIn();
    ctx.tz = 'Asia/Tokyo';
    ctx.locale = 'es';
    ctx.clientBuildId = 'client-claim';
    ctx.authz = { allowed: true };
    ctx.readBody = () => Promise.resolve(new Uint8Array());
    ctx.rateLimit = { allowed: true, limit: 1, remaining: 0, resetAtMs: 1, retryAfterSeconds: 0 };
    withAnonymousRequest(ctx, ctx.url, (scope) => {
      expect(scope.tz).toBe(timeConfig().defaultZone);
      expect(useContext().tz).toBe(timeConfig().defaultZone);
      expect(scope.locale).toBe('es');
      expect(scope.ip).toBeNull();
      expect(scope.peer).toBeNull();
      expect(scope.clientBuildId).toBeNull();
      expect(scope.authz).toBeUndefined();
      expect(scope.rateLimit).toBeUndefined();
      expect(scope.readBody).toBeUndefined();
    });
    expect(ctx.tz).toBe('Asia/Tokyo');
    expect(ctx.ip).toBe('203.0.113.9');
  });

  test('the url is the one it was handed, never the request it came from', () => {
    const ctx = signedIn();
    const narrowed = new URL('https://public.test/x');
    withAnonymousRequest(ctx, narrowed, (scope) => {
      expect(scope.url).toBe(narrowed);
      expect(useRequestContext().url.href).toBe('https://public.test/x');
    });
    expect(ctx.url.href).toBe('https://example.com/x');
  });

  test('it is the ambient request: the same id, and useRequestContext answers the scope', () => {
    const ctx = signedIn();
    withAnonymousRequest(ctx, ctx.url, (scope) => {
      expect(useRequestContext()).toBe(scope);
      expect(scope.requestId).toBe(ctx.requestId);
      expect(scope.url).toBe(ctx.url);
      expect(scope.headers).toBe(ctx.headers);
    });
  });

  test('setRedirect inside lands on the scope, not on the outer context', () => {
    const ctx = signedIn();
    withAnonymousRequest(ctx, ctx.url, (scope) => {
      setRedirect('/elsewhere', 302);
      expect(takeRedirect(scope)).toEqual({ location: '/elsewhere', status: 302 });
    });
    expect(ctx.redirect).toBeUndefined();
  });

  test('a registered service is rebuilt for nobody, on every door to it', () => {
    resetServices();
    defineService('whoami', (facts) => (isAnonymous(facts.actor) ? 'nobody' : facts.actor.id));
    try {
      const ctx = signedIn();
      expect(ctx['whoami']).toBe('alice');
      withAnonymousRequest(ctx, ctx.url, (scope) => {
        expect(scope['whoami']).toBe('nobody');
        expect(scope.services['whoami']).toBe('nobody');
        expect(useContext().services['whoami']).toBe('nobody');
      });
    } finally {
      resetServices();
    }
  });

  test("a registered service is built in the default zone, not the visitor's", () => {
    resetServices();
    defineService('zone', (facts) => facts.tz);
    try {
      const ctx = signedIn();
      ctx.tz = 'Asia/Tokyo';
      withAnonymousRequest(ctx, ctx.url, (scope) => {
        expect(scope['zone']).toBe(timeConfig().defaultZone);
      });
    } finally {
      resetServices();
    }
  });

  test('a service named after a request field never shadows the request', () => {
    resetServices();
    defineService('url', () => 'a service');
    try {
      const ctx = signedIn();
      withAnonymousRequest(ctx, ctx.url, (scope) => {
        expect(scope.url).toBe(ctx.url);
      });
    } finally {
      resetServices();
    }
  });

  test('a hand-built service an app passed is carried, as `withChildContext` carries it', () => {
    const posts = { byId: () => 'a post' };
    withAnonymousRequest(signedIn({ posts }), new URL('https://example.com/x'), (scope) => {
      expect(scope.services['posts']).toBe(posts);
      expect(scope['posts']).toBe(posts);
    });
  });

  test('the scope survives an await, and fn answers what it returned', async () => {
    const answer = await withAnonymousRequest(
      signedIn(),
      new URL('https://example.com/x'),
      async () => {
        await Bun.sleep(0);
        return isAnonymous(useContext().actor);
      },
    );
    expect(answer).toBe(true);
  });
});

describe('elapsedMs', () => {
  test('is a non-negative finite number', () => {
    const ctx = requestContext({
      url: new URL('https://example.com/x'),
      method: 'get',
      role: 'web',
      config,
    });
    const elapsed = elapsedMs(ctx);
    expect(Number.isFinite(elapsed)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });
});

describe('actorView', () => {
  test('null actor reads as null', () => {
    expect(actorView(null)).toBeNull();
  });

  test('the anonymous actor reads as null', () => {
    expect(actorView(anonymousActor())).toBeNull();
  });

  test('a real actor narrows (by cast) to expose id and orgId', () => {
    const actor = userActor({ id: uuidV7(), orgId: 'org-1' });
    expect(isAnonymous(actor)).toBe(false);
    const view = actorView(actor);
    expect(view).not.toBeNull();
    expect(view?.id).toBe(actor.id);
    expect(view?.orgId).toBe('org-1');
    // it's a cast, not a copy, so identity is preserved
    expect(Object.is(view, actor)).toBe(true);
  });
});
