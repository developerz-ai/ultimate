// render on the bus: a route component's render is `render.page` (keyed on the route PATTERN, the
// `http.route` the request span carries), each streamed `<Hole>` fill is `render.hole`, and each ISR
// generation — not each serve — is `render.isr.regenerate`. Success and failure alike.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ReadableSpan, RenderHoleEvent, RenderPageEvent } from '@ultimat3/core';
import {
  alwaysOnSampler,
  configureTelemetry,
  resetInstrumentation,
  resetTelemetry,
  SEMCONV,
  subscribe,
} from '@ultimat3/core';
import { Hole } from './hole';
import { h } from './jsx';
import { clearRoutes, describePages, registerRoute } from './registry';
import { holeSink, renderComponent } from './render-html';
import { isrController } from './render-isr';
import { collectStream, renderStreamHtml } from './render-stream';
import type { RouteMetaFn } from './route';
import { defineRoute } from './route';

const meta = (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;
const FILE = 'apps/web/site/blog/[slug]/page.tsx';

function register(render: 'ssr' | 'isr'): void {
  registerRoute({
    file: FILE,
    config: defineRoute(
      render === 'isr'
        ? {
            render,
            revalidate: { tags: [], ttl: '1m' },
            offline: 'precache',
            hydrate: 'never',
            meta,
          }
        : { render, offline: 'network-only', meta },
    ),
  });
}

function listen<T>(name: 'render.page' | 'render.hole' | 'render.isr.regenerate'): {
  events: T[];
  spans: ReadableSpan[];
} {
  const events: T[] = [];
  const spans: ReadableSpan[] = [];
  subscribe(name, (event) => events.push(event.payload as T));
  subscribe('span.end', (event) => spans.push(event.payload));
  return { events, spans };
}

beforeEach(() => {
  clearRoutes();
  configureTelemetry({ sampler: alwaysOnSampler });
});

afterEach(() => {
  resetInstrumentation();
  resetTelemetry();
});

afterAll(() => {
  clearRoutes();
});

describe('unit · render · instrumentation', () => {
  test('a registered route renders as render.page under its pattern, with an http.route span', async () => {
    register('ssr');
    const seen = listen<RenderPageEvent>('render.page');
    const Page = (): unknown => h('p', null, 'hi');
    expect(await renderComponent(Page, {}, FILE)).toBe('<p>hi</p>');
    expect(seen.events).toHaveLength(1);
    expect(seen.events[0]?.route).toBe('/blog/:slug');
    expect(seen.events[0]?.error).toBeUndefined();
    const span = seen.spans.find((candidate) => candidate.name === 'render.page');
    expect(span?.kind).toBe('internal');
    expect(span?.attributes[SEMCONV.httpRoute]).toBe('/blog/:slug');
  });

  test('a component that throws is still render.page, carrying the coded error', async () => {
    register('ssr');
    const seen = listen<RenderPageEvent>('render.page');
    const boom = new TypeError('boom');
    const Broken = (): unknown => {
      throw boom;
    };
    const thrown = await renderComponent(Broken, {}, FILE).catch((error: unknown) => error);
    expect(seen.events).toHaveLength(1);
    expect(seen.events[0]?.error).toBe(thrown);
  });

  test('a file no route registered reports the file itself — never a guessed pattern', async () => {
    const seen = listen<RenderPageEvent>('render.page');
    await renderComponent(() => 'x', {}, 'apps/web/site/unregistered/page.tsx');
    expect(seen.events[0]?.route).toBe('apps/web/site/unregistered/page.tsx');
  });

  test('each streamed hole fill is render.hole, named by its id under the page route', async () => {
    register('ssr');
    const seen = listen<RenderHoleEvent>('render.hole');
    const sink = holeSink();
    const Page = (): unknown =>
      h('div', null, Hole({ fallback: 'wait', children: Promise.resolve('done') }));
    const shell = await renderComponent(Page, {}, FILE, { holes: sink });
    // The caller's own sink still collects the holes: instrumentation wraps, never replaces.
    expect(sink.holes).toHaveLength(1);
    expect(seen.events).toEqual([]);
    await collectStream(
      renderStreamHtml(
        { head: '<head>', shell, holes: sink.holes },
        { buildId: 'b', holeTimeoutMs: null },
      ),
    );
    expect(seen.events).toHaveLength(1);
    expect(seen.events[0]).toMatchObject({ route: '/blog/:slug', hole: '1' });
    expect(seen.spans.some((span) => span.name === 'render.hole')).toBe(true);
  });

  test('an ISR generation is render.isr.regenerate once, however many requests joined it', async () => {
    register('isr');
    const seen = listen<{ route: string; path: string; error?: unknown }>('render.isr.regenerate');
    const controller = isrController({ routes: describePages });
    const render = async (path: string): Promise<string> => {
      await Promise.resolve();
      return `<p>${path}</p>`;
    };
    await Promise.all([controller.serve('/blog/a', render), controller.serve('/blog/a', render)]);
    await controller.serve('/blog/a', render);
    expect(seen.events).toHaveLength(1);
    expect(seen.events[0]).toMatchObject({ route: '/blog/:slug', path: '/blog/a' });
    expect(seen.spans.some((span) => span.name === 'render.isr.regenerate')).toBe(true);
  });
});
