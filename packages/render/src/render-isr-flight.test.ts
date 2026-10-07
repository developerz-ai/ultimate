// The ISR controller's two lookups that answer "which one": which regeneration holds a path (a hung
// render frees it at the deadline, on an injected scheduler — no wall clock), and which route's TTL
// a stored path takes when several patterns match it (the most specific, as the request router).
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { CacheTag } from '@ultimat3/cache';
import { isolateGraph, resetGraph, tag } from '@ultimat3/cache';
import type { Scheduler } from '@ultimat3/core';
import { clearRoutes, describePages, registerRoute } from './registry';
import { DEFAULT_ISR_REGENERATE_DEADLINE_MS, isrController, isrKey } from './render-isr';
import type { RenderResult, RouteMetaFn } from './route';
import { defineRoute } from './route';

const meta = (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;
const postTag: CacheTag = tag('post');

function isrRoute(file: string, revalidate: { tags?: CacheTag[]; ttl?: string }): void {
  registerRoute({
    file,
    config: defineRoute({ render: 'isr', revalidate, offline: 'precache', hydrate: 'never', meta }),
  });
}

const sMaxAge = (result: RenderResult): string | undefined =>
  /s-maxage=(\d+)/.exec(result.headers['cache-control'] ?? '')?.[1];

/** A scheduler the test fires by hand: each armed deadline, and whether it was cancelled. */
function manualScheduler() {
  const armed: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const schedule: Scheduler = (fn, ms) => {
    const task = { fn, ms, cancelled: false };
    armed.push(task);
    return () => {
      task.cancelled = true;
    };
  };
  const fire = (): void => {
    for (const task of armed.splice(0)) if (!task.cancelled) task.fn();
  };
  return { schedule, armed, fire };
}

const never = (): Promise<string> => new Promise<string>(() => undefined);
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const restoreGraph = isolateGraph();
beforeEach(() => {
  clearRoutes();
  resetGraph();
});
afterAll(() => {
  clearRoutes();
  restoreGraph();
});

describe('a regeneration that never settles', () => {
  test('a tag-only page whose render hangs frees its slot at the deadline', async () => {
    isrRoute('apps/web/site/pricing/page.tsx', { tags: [postTag] });
    const clock = manualScheduler();
    const controller = isrController({ routes: describePages, schedule: clock.schedule });
    let calls = 0;
    const hung = (): Promise<string> => {
      calls += 1;
      return never();
    };

    void controller.serve('/pricing', hung);
    void controller.serve('/pricing', hung);
    expect([calls, controller.inflight()]).toEqual([1, 1]);
    expect(clock.armed.map((task) => task.ms)).toEqual([DEFAULT_ISR_REGENERATE_DEADLINE_MS]);

    clock.fire();
    expect(controller.inflight()).toBe(0);
    // The next request is not joined to the hung promise: it renders, and is answered.
    const served = await controller.serve('/pricing', async () => {
      calls += 1;
      return '<p>v2</p>';
    });
    expect([calls, served.state, served.result.body]).toEqual([2, 'miss', '<p>v2</p>']);
  });

  test('a stale page whose refresh hangs is refreshed again once the deadline passed', async () => {
    isrRoute('apps/web/site/pricing/page.tsx', { tags: [postTag] });
    const clock = manualScheduler();
    const controller = isrController({ routes: describePages, schedule: clock.schedule });
    await controller.serve('/pricing', () => '<p>v1</p>');
    clock.fire();
    controller.markStale('/pricing');

    const first = await controller.serve('/pricing', never);
    expect([first.state, first.regenerating]).toEqual(['stale', true]);
    const joined = await controller.serve('/pricing', never);
    expect(joined.regenerating).toBe(false);

    clock.fire();
    const again = await controller.serve('/pricing', async () => '<p>v2</p>');
    expect([again.state, again.regenerating]).toEqual(['stale', true]);
    await tick();
    expect((await controller.serve('/pricing', never)).result.body).toBe('<p>v2</p>');
  });

  test('an evicted render that settles late never overwrites the page rendered after it', async () => {
    isrRoute('apps/web/site/pricing/page.tsx', { tags: [postTag] });
    const clock = manualScheduler();
    const controller = isrController({ routes: describePages, schedule: clock.schedule });
    let release = (_html: string): void => undefined;
    const late = controller.serve(
      '/pricing',
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    clock.fire();
    await controller.serve('/pricing', () => '<p>new</p>');
    release('<p>old</p>');
    await late;
    expect(controller.store().get('/pricing')?.html).toBe('<p>new</p>');
  });

  test('an evicted render that settles with no successor still publishes its page', async () => {
    isrRoute('apps/web/site/pricing/page.tsx', { tags: [postTag] });
    const clock = manualScheduler();
    const controller = isrController({ routes: describePages, schedule: clock.schedule });
    let release = (_html: string): void => undefined;
    const late = controller.serve(
      '/pricing',
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    clock.fire();
    release('<p>slow</p>');
    await late;
    expect(controller.store().get('/pricing')?.html).toBe('<p>slow</p>');
  });

  test('a settled render cancels its deadline', async () => {
    isrRoute('apps/web/site/pricing/page.tsx', { tags: [postTag] });
    const clock = manualScheduler();
    const controller = isrController({ routes: describePages, schedule: clock.schedule });
    await controller.serve('/pricing', () => '<p>v1</p>');
    expect(clock.armed.map((task) => task.cancelled)).toEqual([true]);
  });

  test('the deadline is configurable, and refused when it is not a whole number of ms', () => {
    const clock = manualScheduler();
    const controller = isrController({
      routes: describePages,
      schedule: clock.schedule,
      regenerateDeadlineMs: 1_500,
    });
    void controller.regenerate('/x', never);
    expect(clock.armed.map((task) => task.ms)).toEqual([1_500]);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => isrController({ regenerateDeadlineMs: bad })).toThrow(/regenerateDeadlineMs/);
    }
  });
});

describe('the route a stored path takes its TTL from', () => {
  test('a param route beats a catch-all for one segment; the catch-all keeps the rest', async () => {
    // Registered in this order AND sorted `*` before `:` by `describePages()`: the first match
    // was the catch-all, so `/docs/7` took `/docs/*path`'s TTL.
    isrRoute('apps/web/site/docs/[...path]/page.tsx', { ttl: '1h' });
    isrRoute('apps/web/site/docs/[id]/page.tsx', { ttl: '30s' });
    expect(describePages().map((route) => route.path)).toEqual(['/docs/*path', '/docs/:id']);
    const controller = isrController({ routes: describePages });
    const render = (path: string): string => `<p>${path}</p>`;
    expect(sMaxAge((await controller.serve('/docs/7', render)).result)).toBe('30');
    expect(sMaxAge((await controller.serve('/docs/7/edit', render)).result)).toBe('3600');
  });

  test('the bare prefix a catch-all is written at takes the catch-all TTL', async () => {
    isrRoute('apps/web/site/docs/[...path]/page.tsx', { ttl: '1h' });
    const controller = isrController({ routes: describePages });
    expect(sMaxAge((await controller.serve('/docs', (path) => path)).result)).toBe('3600');
  });

  test('a route named outside ASCII is found by the encoded pathname a request carries', async () => {
    isrRoute('apps/web/site/precios-españa/page.tsx', { ttl: '30s' });
    isrRoute('apps/web/site/precios-españa/[plan]/page.tsx', { ttl: '1h' });
    const controller = isrController({ routes: describePages });
    const key = isrKey(new URL('https://app.test/precios-españa'), 'en');
    expect(key.startsWith('/precios-espa%C3%B1a?')).toBe(true);
    expect(sMaxAge((await controller.serve(key, (path) => path)).result)).toBe('30');
    const plan = isrKey(new URL('https://app.test/precios-españa/pro'), 'en');
    expect(sMaxAge((await controller.serve(plan, (path) => path)).result)).toBe('3600');
  });

  test('a static segment beats a param at the first segment where they differ', async () => {
    isrRoute('apps/web/site/[section]/b/c/page.tsx', { ttl: '1h' });
    isrRoute('apps/web/site/a/[x]/[y]/page.tsx', { ttl: '30s' });
    const controller = isrController({ routes: describePages });
    const served = await controller.serve('/a/b/c', (path) => `<p>${path}</p>`);
    expect(sMaxAge(served.result)).toBe('30');
  });
});
