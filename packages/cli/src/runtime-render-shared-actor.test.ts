// A shared document (`isr`, `static`) is rendered as nobody. Reproduced over the real modules: a
// signed-in visitor filled the store, and the next anonymous request received her row under
// `public` cache headers. Every door a `load` has to a visitor is held here, in both modes.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { isolateGraph } from '@ultimat3/cache';
import {
  defineService,
  isAnonymous,
  resetServices,
  useContext,
  userActor,
  useService,
} from '@ultimat3/core';
import {
  defineHttpConfig,
  httpServer,
  setRedirect,
  useRequestContext,
  useRequestCookie,
  useRequestHeader,
} from '@ultimat3/http';
import { configureLocales, resetLocaleConfig } from '@ultimat3/i18n';
import { clearRoutes, defineRoute, h, registerRoute } from '@ultimat3/render';
import { isrController } from '@ultimat3/render/server';
import { attachedIsr } from './runtime-isr';
import { appRoutes } from './runtime-render';

const BUILD_ID = 'shared-actor-under-test';
const ALICE = userActor({ id: 'SECRET-alice', tz: 'Asia/Tokyo' });
const COOKIE = 'session=SECRET-cookie';
const BEARER = 'Bearer SECRET-token';
const SECRET = /SECRET|Asia\/Tokyo/;

type SharedMode = 'isr' | 'static';

/** Everything a `load` could learn about the visitor, as the document would then print it. */
function seen(): Record<string, string> {
  const { actor } = useContext();
  return {
    actor: isAnonymous(actor) ? 'nobody' : actor.id,
    service: useService<() => string>('whoami')(),
    cookie: useRequestCookie('session') ?? 'none',
    authorization: useRequestHeader('authorization') ?? 'none',
    apiKey: useRequestHeader('x-api-key') ?? 'none',
    proxy: useRequestHeader('proxy-authorization') ?? 'none',
    email: useRequestHeader('x-forwarded-email') ?? 'none',
    zone: useContext().tz,
    url: useRequestContext().url.href,
    ip: useRequestContext().ip ?? 'none',
  };
}

const textOf = (data: unknown): string => JSON.stringify(data);

function register(
  render: SharedMode,
  load: () => Record<string, string>,
  file = 'apps/web/site/shared/page.tsx',
): void {
  registerRoute({
    file,
    component: (props: { readonly data?: unknown }) => h('p', {}, `seen ${textOf(props.data)}`),
    config: defineRoute({
      render,
      ...(render === 'isr' ? { revalidate: { ttl: '5m', query: [] } } : {}),
      offline: 'network-only',
      hydrate: 'never',
      budget: { js: '0kb' },
      load,
      // `meta` runs inside the document, and a title is a place a value leaks to.
      meta: () => ({ title: textOf(seen()), description: 'a shared document under test' }),
    }),
  });
}

function serving() {
  const { isr, release } = attachedIsr({ buildId: BUILD_ID, failureCooldownMs: 0 });
  const server = httpServer({
    routes: appRoutes({ buildId: BUILD_ID, isr, memoStatic: true }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
    hooks: {
      authenticate: (request) => (request.header('cookie') === null ? null : ALICE),
      authorize: () => ({ allowed: true }),
    },
  });
  const at = (path: string) =>
    server.fetch(
      new Request(`http://dev.test${path}`, {
        headers: {
          cookie: COOKIE,
          authorization: BEARER,
          'x-api-key': 'SECRET-key',
          'proxy-authorization': 'Basic SECRET-proxy',
          'x-forwarded-email': 'SECRET-email',
        },
      }),
    );
  const anonymous = () => server.fetch(new Request('http://dev.test/shared'));
  return { release, anonymous, alice: () => at('/shared'), at };
}

const restoreGraph = isolateGraph();
const MODES: readonly SharedMode[] = ['isr', 'static'];

const installWhoami = (): void => {
  resetServices();
  defineService('whoami', (ctx) => () => (isAnonymous(ctx.actor) ? 'nobody' : ctx.actor.id));
};

afterEach(() => {
  clearRoutes();
  resetServices();
});

afterAll(() => {
  isrController().attach()();
  restoreGraph();
});

describe('unit · a shared document is rendered as nobody', () => {
  for (const mode of MODES) {
    test(`${mode}: signed in, then anonymous: no actor value reaches either body`, async () => {
      installWhoami();
      register(mode, seen);
      const { release, anonymous, alice } = serving();

      const first = await (await alice()).text();
      expect(first).not.toMatch(SECRET);
      expect(first).toContain('nobody');
      // Whatever a signed-in render kept, or a CDN would be handed, holds nothing of hers.
      const second = await anonymous();
      expect(second.headers.get('cache-control')).toContain('public');
      const body = await second.text();
      expect(body).not.toMatch(SECRET);
      expect(body).toContain('nobody');
      release();
    });

    test(`${mode}: load reads the document's URL off the context, not what the request wrote`, async () => {
      installWhoami();
      register(mode, seen);
      const { release, at, anonymous } = serving();
      const body = await (await at('/shared?token=SECRET-query')).text();
      if (mode === 'isr') expect(body).not.toMatch(SECRET);
      expect(await (await anonymous()).text()).not.toMatch(SECRET);
      release();
    });

    test(`${mode}: a spelling of the address is not what ctx.url holds`, async () => {
      installWhoami();
      register(mode, seen);
      const { release, at } = serving();
      const body = await (await at('//shared//')).text();
      expect(body).toContain('&quot;url&quot;:&quot;http://dev.test/shared&quot;');
      release();
    });

    test(`${mode}: setRedirect in load still answers its Location`, async () => {
      installWhoami();
      register(mode, () => {
        setRedirect('/elsewhere', 302);
        return {};
      });
      const { release, alice, anonymous } = serving();

      for (const request of [alice, anonymous]) {
        const response = await request();
        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toBe('/elsewhere');
      }
      release();
    });

    test(`${mode}: the request's own answer is still its own`, async () => {
      installWhoami();
      register(mode, seen);
      const { release, alice } = serving();
      // The identified request is told the page is private, because the pipeline still knows who
      // asked: rendering as nobody narrows what `load` sees, not what the response stage knows.
      const response = await alice();
      expect(response.headers.get('cache-control')).toContain('private');
      release();
    });
  }

  test('isr: a request answered for itself alone is rendered as nobody too', async () => {
    installWhoami();
    configureLocales({ supported: ['es-CO', 'en'], fallback: 'es-CO' });
    try {
      register('isr', () => ({}), 'apps/web/site/news/page.tsx');
      // `//en/news` is this route, with no locale, and its key reads back as the English `/news`
      // page's: answered uncached (`ownOutcome`), and still the page every other visitor gets.
      register('isr', seen, 'apps/web/site/[lang]/news/page.tsx');
      const app = serving();

      const response = await app.at('//en/news');
      expect(response.headers.get('cache-control')).toContain('no-store');
      const body = await response.text();
      expect(body).toContain('nobody');
      expect(body).not.toMatch(SECRET);
      app.release();
    } finally {
      resetLocaleConfig();
    }
  });

  test('isr: setRedirect in the load of a request answered for itself still redirects', async () => {
    installWhoami();
    configureLocales({ supported: ['es-CO', 'en'], fallback: 'es-CO' });
    try {
      register('isr', () => ({}), 'apps/web/site/news/page.tsx');
      register(
        'isr',
        () => {
          setRedirect('/elsewhere', 302);
          return {};
        },
        'apps/web/site/[lang]/news/page.tsx',
      );
      const app = serving();

      const response = await app.at('//en/news');
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/elsewhere');
      app.release();
    } finally {
      resetLocaleConfig();
    }
  });

  test('ssr is untouched: the per-visitor mode still sees the visitor', async () => {
    installWhoami();
    registerRoute({
      file: 'apps/web/site/own/page.tsx',
      component: (props: { readonly data?: unknown }) => h('p', {}, textOf(props.data)),
      config: defineRoute({
        render: 'ssr',
        offline: 'network-only',
        hydrate: 'never',
        budget: { js: '0kb' },
        load: seen,
        meta: () => ({ title: 'own', description: 'a per-visitor document under test' }),
      }),
    });
    const server = httpServer({
      routes: appRoutes({ buildId: BUILD_ID }),
      role: 'web',
      config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
      hooks: { authenticate: () => ALICE, authorize: () => ({ allowed: true }) },
    });
    const response = await server.fetch(
      new Request('http://dev.test/own', { headers: { cookie: COOKIE, authorization: BEARER } }),
    );
    const body = await response.text();
    expect(body).toContain('SECRET-alice');
    expect(body).toContain('SECRET-cookie');
  });
});
