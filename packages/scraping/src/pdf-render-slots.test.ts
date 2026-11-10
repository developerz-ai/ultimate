// The renderer's bound on live browsers: at most `maxConcurrent` launched at once, a queued render
// refused with a code past its deadline, and an aborted request releasing its slot and its browser.
// Every wait is bounded by `within`: a lost bound or kill leaves a render pending, and that must
// fail in a second naming the wait, not idle out the runner's test timeout.

import { describe, expect, test } from 'bun:test';
import { noWaitClock } from '@ultimat3/core';
import { chromePdfRenderer, DEFAULT_PDF_MAX_CONCURRENT, pdfLaunchOptions } from './pdf-render';
import type { FakePdfBrowser } from './pdf-render-fixture';
import { fakePdfBrowser } from './pdf-render-fixture';

const URL_ = 'http://app.test/invoices/42/print';

/** Launches counted, each print held until the test opens its gate. */
function gatedLaunches() {
  const launched: FakePdfBrowser[] = [];
  const gates: (() => void)[] = [];
  return {
    launched,
    open: (index: number) => gates[index]?.(),
    launch: () => {
      let open: () => void = () => undefined;
      const printGate = new Promise<void>((resolve) => {
        open = resolve;
      });
      gates.push(open);
      const fake = fakePdfBrowser({ printGate });
      launched.push(fake);
      return Promise.resolve(fake.browser);
    },
  };
}

/** Far above a fake print's microtask hops; far below bun's per-test timeout. */
const WAIT_MS = 1_000;

/** `work`, or a verdict naming what never settled once `WAIT_MS` passed. */
async function within<T>(work: Promise<T>, what: string): Promise<T> {
  const late = Symbol('late');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof late>((resolve) => {
    // real-clock: a watchdog on a hang, never a wait — a passing render settles first and clears it.
    timer = setTimeout(() => resolve(late), WAIT_MS);
  });
  const settled = await Promise.race([work, deadline]).finally(() => clearTimeout(timer));
  if (settled === late) expect.unreachable(`${what} did not settle within ${WAIT_MS} ms`);
  return settled as T;
}

const settle = async (): Promise<void> => {
  for (let hop = 0; hop < 20; hop += 1) await Promise.resolve();
};

describe('unit · chromePdfRenderer concurrency', () => {
  test('a small default, and the production launch keeps the sandbox', () => {
    expect(DEFAULT_PDF_MAX_CONCURRENT).toBe(2);
    expect(pdfLaunchOptions(30_000)).toMatchObject({ sandbox: true });
  });

  test('never more than maxConcurrent browsers; a queued render launches when one ends', async () => {
    const gated = gatedLaunches();
    const renderer = chromePdfRenderer({ launch: gated.launch, maxConcurrent: 2 });
    const renders = [0, 1, 2].map(() => renderer.render({ url: URL_, layout: {} }));
    await settle();
    expect(gated.launched).toHaveLength(2);
    gated.open(0);
    await within(
      renders[0] ?? expect.unreachable('three renders were started'),
      'the first render, its gate open',
    );
    await settle();
    expect(gated.launched).toHaveLength(3);
    gated.open(1);
    gated.open(2);
    await within(Promise.all(renders), 'every render, every gate open');
    expect(gated.launched.every((fake) => fake.closed())).toBe(true);
  });

  test('a render queued past its deadline is X_SCRAPE_PDF_BUSY, and never launches', async () => {
    const gated = gatedLaunches();
    const renderer = chromePdfRenderer({
      launch: gated.launch,
      maxConcurrent: 1,
      clock: noWaitClock,
    });
    const first = renderer.render({ url: URL_, layout: {} });
    await settle();
    const busy = renderer.render({ url: URL_, layout: {} });
    await expect(within(busy, 'the render queued past its deadline')).rejects.toMatchObject({
      code: 'X_SCRAPE_PDF_BUSY',
    });
    expect(gated.launched).toHaveLength(1);
    gated.open(0);
    await within(first, 'the first render, its gate open');
  });

  test('a request aborted while queued leaves the queue, launching nothing', async () => {
    const gated = gatedLaunches();
    const renderer = chromePdfRenderer({ launch: gated.launch, maxConcurrent: 1 });
    const first = renderer.render({ url: URL_, layout: {} });
    const cancel = new AbortController();
    const queued = renderer.render({ url: URL_, layout: {}, signal: cancel.signal });
    await settle();
    cancel.abort(new Error('client went away'));
    await expect(within(queued, 'the render aborted in the queue')).rejects.toThrow(
      'client went away',
    );
    gated.open(0);
    await within(first, 'the first render, its gate open');
    expect(gated.launched).toHaveLength(1);
  });

  test('a request aborted mid-print kills its browser and frees its slot', async () => {
    const gated = gatedLaunches();
    const renderer = chromePdfRenderer({ launch: gated.launch, maxConcurrent: 1 });
    const cancel = new AbortController();
    const printing = renderer.render({ url: URL_, layout: {}, signal: cancel.signal });
    await settle();
    cancel.abort(new Error('client went away'));
    await expect(within(printing, 'the render aborted mid-print')).rejects.toThrow(
      'client went away',
    );
    expect(gated.launched[0]?.closed()).toBe(true);
    const next = renderer.render({ url: URL_, layout: {} });
    await settle();
    expect(gated.launched).toHaveLength(2);
    gated.open(1);
    await within(next, 'the render that took the freed slot');
  });
});
