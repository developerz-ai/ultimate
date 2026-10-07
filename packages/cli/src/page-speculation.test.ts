// `pageSpeculation` is the one composition the three document writers take the browser's prefetch
// rules from. What is pinned, failures first: a page whose GET may record something is never a
// candidate, a document that carries the client router carries no rules, `prefetch: false` emits
// nothing — and the policy source is the hash of the exact bytes the document carries.

import { afterEach, describe, expect, test } from 'bun:test';
import type { RenderMode, SpeculationConfig } from '@ultimat3/core';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import type { RouteNavigationMode } from '@ultimat3/render';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { measureDocumentJs } from './budgets';
import type { NavigationDocumentHead } from './page-navigation';
import { pageSpeculation, speculationCandidate } from './page-speculation';
import { appRoutes } from './runtime-render';
import { inlineScriptSources } from './script-csp';

const BUILD_ID = 'build-under-test';
const ON: SpeculationConfig = { prefetch: 'moderate', exclude: [] };
const ROUTER: NavigationDocumentHead = {
  surfaces: new Set(['app']),
  scriptUrl: '/_x/navigation/n.js',
  buildId: BUILD_ID,
  app: 'web',
};

afterEach(() => {
  clearRoutes();
});

interface PageOptions {
  readonly navigation?: RouteNavigationMode;
  readonly offline?: 'precache' | 'runtime' | 'network-only';
  readonly gated?: boolean;
}

function page(file: string, render: RenderMode, options: PageOptions = {}): void {
  registerRoute({
    file,
    suspenseBoundaries: render === 'stream' ? 1 : 0,
    config: defineRoute({
      render,
      offline: options.offline ?? (render === 'static' ? 'precache' : 'runtime'),
      hydrate: 'never',
      budget: { js: '0kb' },
      ...(render === 'isr' ? { revalidate: { ttl: '1h', tags: [] } } : {}),
      ...(options.navigation === undefined ? {} : { navigation: options.navigation }),
      ...(options.gated === true ? { policy: { permission: 'casos.read' } } : {}),
      load: () => ({}),
      meta: () => ({ title: file, description: 'speculation under test' }),
    }),
  });
}

const included = (body: string): readonly string[] => {
  const where = (
    JSON.parse(body) as {
      prefetch: [{ where: { href_matches?: string[]; and?: [{ href_matches: string[] }] } }];
    }
  ).prefetch[0].where;
  return where.href_matches ?? where.and?.[0].href_matches ?? [];
};

const rules = (config: SpeculationConfig = ON, client: readonly ('site' | 'app')[] = ['app']) =>
  pageSpeculation({ config, client, localeSegments: [] });

/** The text between the tags of the document's speculation script, exactly as served. */
const emittedBody = (html: string): string | undefined =>
  /<script type="speculationrules">(?<body>[\s\S]*?)<\/script>/.exec(html)?.groups?.['body'];

describe('which pages a browser may fetch early', () => {
  test('refused: a page that records, a personal page, a network-only page, an api route', () => {
    page('apps/web/site/precios/page.tsx', 'static');
    page('apps/web/site/verificar/page.tsx', 'ssr');
    page('apps/web/site/vivo/page.tsx', 'static', { offline: 'network-only' });
    page('apps/web/app/r/[token]/page.tsx', 'ssr', { navigation: 'document' });
    page('apps/web/app/casos/page.tsx', 'ssr', { gated: true });
    page('apps/web/app/plazos/page.tsx', 'ssr', { navigation: 'prefetch', gated: true });
    const speculation = rules();
    // The prerendered site page, and the one app page that DECLARED its GET a pure read.
    expect(included(speculation?.body ?? '{}')).toEqual(['/plazos', '/precios']);
  });

  test('a surface without the router has no way to say "pure read": only prerendered pages', () => {
    page('apps/web/app/casos/page.tsx', 'ssr');
    page('apps/web/site/ayuda/page.tsx', 'isr');
    expect(included(rules(ON, [])?.body ?? '{}')).toEqual(['/ayuda']);
  });

  test('a prerendered page rendered FOR someone is not a candidate', () => {
    const entry = {
      surface: 'site',
      config: defineRoute({
        render: 'static',
        offline: 'precache',
        hydrate: 'never',
        budget: { js: '0kb' },
        load: () => ({}),
        meta: () => ({ title: 't', description: 'd' }),
      }),
    } as const;
    const facts = { mode: 'static', offline: 'precache' } as const;
    expect(speculationCandidate(entry, { ...facts, personal: false }, new Set())).toBe(true);
    expect(speculationCandidate(entry, { ...facts, personal: true }, new Set())).toBe(false);
  });

  test('every routed locale, and the app’s own exclusions', () => {
    page('apps/web/site/page.tsx', 'static');
    page('apps/web/site/blog/[slug]/page.tsx', 'static');
    const speculation = pageSpeculation({
      config: { prefetch: 'conservative', exclude: ['/blog/borrador-*'] },
      client: [],
      localeSegments: ['en'],
    });
    expect(JSON.parse(speculation?.body ?? '{}')).toEqual({
      prefetch: [
        {
          where: {
            and: [
              { href_matches: ['{/en}?/', '{/en}?/blog/:slug'] },
              { not: { href_matches: ['/blog/borrador-*'] } },
            ],
          },
          eagerness: 'conservative',
        },
      ],
    });
  });

  test('prefetch: false, or no candidate page: nothing to emit and nothing to admit', () => {
    page('apps/web/site/precios/page.tsx', 'static');
    expect(rules({ prefetch: false, exclude: [] })).toBeUndefined();
    clearRoutes();
    page('apps/web/app/casos/page.tsx', 'ssr');
    expect(rules()).toBeUndefined();
  });
});

describe('the document and the policy', () => {
  const serve = (speculation: NonNullable<ReturnType<typeof rules>>) =>
    httpServer({
      routes: appRoutes({
        buildId: BUILD_ID,
        navigation: ROUTER,
        speculationHead: speculation.head,
      }),
      role: 'web',
      config: defineHttpConfig({
        dev: false,
        buildId: BUILD_ID,
        rateLimit: { scope: 'process' },
        // What `startRoles` does with a boot's `inlineScripts`.
        security: {
          csp: { extend: { 'script-src': inlineScriptSources([speculation.cspSource]) } },
        },
      }),
    });

  test('a static page carries the rules, and the enforced CSP hashes its exact bytes', async () => {
    page('apps/web/site/precios/page.tsx', 'static');
    page('apps/web/site/contacto/page.tsx', 'static');
    const speculation = rules();
    if (speculation === undefined) return expect.unreachable('two static pages are candidates');
    const answer = await serve(speculation).fetch(new Request('http://app.test/precios'));
    const html = await answer.text();
    const body = emittedBody(html);
    if (body === undefined) return expect.unreachable('the document carries no speculation rules');
    expect(JSON.parse(body)).toEqual({
      prefetch: [{ where: { href_matches: ['/contacto', '/precios'] }, eagerness: 'moderate' }],
    });
    // Hashed HERE, from the served bytes — never read back from `speculation.cspSource`.
    const hash = new Bun.CryptoHasher('sha256').update(body).digest('base64');
    const policy = answer.headers.get('content-security-policy') ?? '';
    const scriptSrc = policy.split('; ').find((directive) => directive.startsWith('script-src '));
    expect(scriptSrc).toContain(`'sha256-${hash}'`);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  test('a document that names the client router carries no rules; a document page does', async () => {
    page('apps/web/site/precios/page.tsx', 'static');
    page('apps/web/app/casos/page.tsx', 'ssr');
    page('apps/web/app/r/[token]/page.tsx', 'ssr', { navigation: 'document' });
    const speculation = rules();
    if (speculation === undefined) return expect.unreachable('a static page is a candidate');
    const server = serve(speculation);
    const routed = await (await server.fetch(new Request('http://app.test/casos'))).text();
    expect(routed).toContain('/_x/navigation/n.js');
    expect(emittedBody(routed)).toBeUndefined();
    const plain = await (await server.fetch(new Request('http://app.test/r/abc'))).text();
    expect(plain).not.toContain('/_x/navigation/n.js');
    expect(emittedBody(plain)).toBe(speculation.body);
  });

  test('the rules are data: a 0kb page is charged no JavaScript for them', async () => {
    page('apps/web/site/precios/page.tsx', 'static');
    const speculation = rules();
    if (speculation === undefined) return expect.unreachable('a static page is a candidate');
    const measured = await measureDocumentJs(`<head>${speculation.head}</head>`, '/nonexistent');
    expect(measured.jsBytes).toBe(0);
  });
});
