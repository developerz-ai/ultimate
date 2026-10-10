// What ISR never keeps. A `load` that answered `withStatus(503)` — the app's "the read failed, try
// again" — was stored with its document for the whole TTL plus one stale serve, so one upstream
// blip became minutes of 503 on a page whose data had long recovered.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { CacheTag } from '@ultimat3/cache';
import { isolateGraph, resetGraph, tag } from '@ultimat3/cache';
import type { LogSink } from '@ultimat3/core';
import { setLogSink } from '@ultimat3/core';
import { clearRoutes, describePages } from './registry';
import { isrController } from './render-isr';
import { isrKeyIn, isrRouteWith } from './render-isr-fixture';

const postTag: CacheTag = tag('post');
const POST = 'apps/web/site/blog/[slug]/page.tsx';
const restoreGraph = isolateGraph();

beforeEach(() => {
  clearRoutes();
  resetGraph();
  isrRouteWith(POST, { tags: [postTag], ttl: '1m' });
});

afterAll(() => {
  clearRoutes();
  restoreGraph();
});

/** The log lines one test produced, as written. */
async function logged(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const collect: LogSink = (line) => {
    lines.push(line);
  };
  const previous = setLogSink(collect);
  try {
    await run();
  } finally {
    setLogSink(previous);
  }
  return lines.join('\n');
}

const down = () => ({ html: '<p>try again</p>', status: 503 });

describe('unit · a 5xx render is never stored', () => {
  test('on a miss it answers its own request, private, and the next request renders again', async () => {
    const controller = isrController({ routes: describePages });
    const key = isrKeyIn('/blog/a');
    const failed = await controller.serve(key, down);
    expect(failed.state).toBe('miss');
    expect(failed.result.status).toBe(503);
    expect(failed.result.headers['cache-control']).toBe('private, no-store');
    expect(failed.result.headers['surrogate-key']).toBeUndefined();
    expect(failed.result.headers['etag']).toBeUndefined();
    expect(controller.store().get(key)).toBeUndefined();

    const recovered = await controller.serve(key, () => '<p>post</p>');
    expect({ state: recovered.state, status: recovered.result.status }).toEqual({
      state: 'miss',
      status: 200,
    });
    expect(controller.store().get(key)?.html).toBe('<p>post</p>');
  });

  test('it never replaces a good entry: the last good page is served stale, and it is logged', async () => {
    let clock = 0;
    const controller = isrController({ routes: describePages, now: () => clock });
    const key = isrKeyIn('/blog/a');
    await controller.serve(key, () => '<p>good</p>');
    clock = 61_000;

    const messages = await logged(async () => {
      const stale = await controller.serve(key, down);
      expect(stale.state).toBe('stale');
      expect(stale.result.body).toBe('<p>good</p>');
      // The refresh behind it, awaited: the regeneration is single-flight, so this joins it.
      await controller.regenerate(key, down);
    });
    expect(messages).toContain('isr.render.unstored');
    expect(controller.store().get(key)?.html).toBe('<p>good</p>');

    // Still the last good page while the read stays down, and the fresh one once it is back.
    expect((await controller.serve(key, down)).result.body).toBe('<p>good</p>');
    await controller.regenerate(key, down);
    await controller.regenerate(key, () => '<p>better</p>');
    const back = await controller.serve(key, () => '<p>never called</p>');
    expect({ state: back.state, body: back.result.body }).toEqual({
      state: 'hit',
      body: '<p>better</p>',
    });
  });

  test('a 4xx is still a stored page: a 404 answers every hit for its ttl', async () => {
    const controller = isrController({ routes: describePages });
    const key = isrKeyIn('/blog/nope');
    await controller.serve(key, () => ({ html: '<p>nope</p>', status: 404 }));
    expect((await controller.serve(key, down)).state).toBe('hit');
  });
});

describe('unit · a render that says noStore', () => {
  test('is answered private and never written', async () => {
    const controller = isrController({ routes: describePages });
    const key = isrKeyIn('/blog/a');
    const served = await controller.serve(key, () => ({
      html: '<p>preview</p>',
      status: 200,
      noStore: true,
    }));
    expect(served.result.body).toBe('<p>preview</p>');
    expect(served.result.headers['cache-control']).toBe('private, no-store');
    expect(controller.store().paths()).toEqual([]);
  });

  test('drops the copy it was regenerating: that page is no longer the answer', async () => {
    let clock = 0;
    const controller = isrController({ routes: describePages, now: () => clock });
    const key = isrKeyIn('/blog/a');
    await controller.serve(key, () => '<p>old</p>');
    clock = 61_000;
    await controller.regenerate(key, () => ({
      html: '<p>preview</p>',
      status: 200,
      noStore: true,
    }));
    expect(controller.store().get(key)).toBeUndefined();
  });
});

describe('unit · a render that throws', () => {
  const broken = () => Promise.reject(new Error('the driver went away'));

  test('on a miss the request is refused with the render’s own error, and nothing is stored', async () => {
    const controller = isrController({ routes: describePages });
    const key = isrKeyIn('/blog/a');
    await expect(controller.serve(key, broken)).rejects.toThrow('the driver went away');
    expect(controller.store().paths()).toEqual([]);
    expect(controller.inflight()).toBe(0);
  });

  test('behind a stale page the last good copy keeps answering, and the failure is logged', async () => {
    let clock = 0;
    const controller = isrController({ routes: describePages, now: () => clock });
    const key = isrKeyIn('/blog/a');
    await controller.serve(key, () => '<p>good</p>');
    clock = 61_000;
    const messages = await logged(async () => {
      const stale = await controller.serve(key, broken);
      expect(stale.result.body).toBe('<p>good</p>');
      await controller.regenerate(key, broken).catch(() => undefined);
      await Bun.sleep(0);
    });
    expect(messages).toContain('isr.regenerate.failed');
    expect((await controller.serve(key, broken)).result.body).toBe('<p>good</p>');
  });
});
