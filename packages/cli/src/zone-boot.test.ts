// `time.detect`: the zone script rides every `app/` document in every mode its surface allows and
// NO `site/` document (axiom 6), admitted by a CSP hash of the very body it carries.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { defineConfig, resetLifecycle } from '@ultimat3/core';
import { cspHashSource, defineHttpConfig, httpServer } from '@ultimat3/http';
import type { RenderMode } from '@ultimat3/render';
import {
  clearRoutes,
  defineRoute,
  registerRoute,
  SURFACE_SPECS,
  zoneScriptBody,
} from '@ultimat3/render';
import { clientScriptHeads } from './client-vitals-route';
import { appRoutes } from './runtime-render';
import { zoneBoot } from './zone-boot';

const BUILD_ID = 'build-under-test';
const detecting = defineConfig({ name: 'demo', time: { detect: true } }).time;

describe('unit · zoneBoot', () => {
  test('nothing unless the app said `time.detect: true`', () => {
    expect(zoneBoot(undefined)).toBeUndefined();
    expect(zoneBoot(defineConfig({ name: 'demo' }).time)).toBeUndefined();
  });

  test('the tag and the hash come from one body', () => {
    const boot = zoneBoot(detecting);
    expect(boot?.head).toBe(`<script>${zoneScriptBody()}</script>`);
    expect(boot?.cspSource).toBe(cspHashSource(zoneScriptBody()));
  });

  test('composes into the app head ahead of the reporters, never into the site head', () => {
    const boot = zoneBoot(detecting);
    if (boot === undefined) return expect.unreachable('time.detect: true boots the zone script');
    expect(clientScriptHeads(undefined, undefined, boot)).toEqual({ appHead: boot.head });
    expect(clientScriptHeads({ head: '<e>' }, undefined, boot).appHead).toBe(`${boot.head}<e>`);
    expect(clientScriptHeads(undefined, undefined, undefined)).toEqual({});
  });
});

const PAGES = [
  { surface: 'site', file: 'apps/web/site/page.tsx', url: '/', carries: false },
  { surface: 'app', file: 'apps/web/app/feed/page.tsx', url: '/feed', carries: true },
] as const;
const CASES = PAGES.flatMap((page) =>
  SURFACE_SPECS[page.surface].allowedModes.map((render) => ({ ...page, render })),
);

function register(file: string, render: RenderMode): void {
  registerRoute({
    file,
    config: defineRoute({
      render,
      offline: 'network-only',
      hydrate: 'never',
      budget: { js: '0kb' },
      meta: () => ({ title: 'a page', description: 'a page under test' }),
      ...(render === 'isr' ? { revalidate: { ttl: '5m' } } : {}),
    }),
  });
}

beforeEach(() => resetLifecycle());
afterEach(() => {
  clearRoutes();
  resetLifecycle();
});

describe('unit · the zone script on a served document', () => {
  test.each(CASES)(
    '$surface/ in $render: carried = $carries',
    async ({ file, url, render, carries }) => {
      register(file, render);
      const server = httpServer({
        routes: appRoutes({
          buildId: BUILD_ID,
          ...clientScriptHeads(undefined, undefined, zoneBoot(detecting)),
        }),
        role: 'web',
        config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
      });
      const body = await (await server.fetch(new Request(`http://dev.test${url}`))).text();
      const head = body.slice(0, body.indexOf('</head>'));
      if (carries) expect(head).toContain(zoneScriptBody());
      else expect(body).not.toContain('x_timezone_detected');
    },
  );
});
