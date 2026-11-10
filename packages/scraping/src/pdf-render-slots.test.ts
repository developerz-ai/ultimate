// The renderer's bound on live browsers: at most `maxConcurrent` launched at once, a queued render
// refused with a code past its deadline, and an aborted request releasing its slot and its browser.

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
    await renders[0];
    await settle();
    expect(gated.launched).toHaveLength(3);
    gated.open(1);
    gated.open(2);
    await Promise.all(renders);
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
    await expect(renderer.render({ url: URL_, layout: {} })).rejects.toMatchObject({
      code: 'X_SCRAPE_PDF_BUSY',
    });
    expect(gated.launched).toHaveLength(1);
    gated.open(0);
    await first;
  });

  test('a request aborted while queued leaves the queue, launching nothing', async () => {
    const gated = gatedLaunches();
    const renderer = chromePdfRenderer({ launch: gated.launch, maxConcurrent: 1 });
    const first = renderer.render({ url: URL_, layout: {} });
    const cancel = new AbortController();
    const queued = renderer.render({ url: URL_, layout: {}, signal: cancel.signal });
    await settle();
    cancel.abort(new Error('client went away'));
    await expect(queued).rejects.toThrow('client went away');
    gated.open(0);
    await first;
    expect(gated.launched).toHaveLength(1);
  });

  test('a request aborted mid-print kills its browser and frees its slot', async () => {
    const gated = gatedLaunches();
    const renderer = chromePdfRenderer({ launch: gated.launch, maxConcurrent: 1 });
    const cancel = new AbortController();
    const printing = renderer.render({ url: URL_, layout: {}, signal: cancel.signal });
    await settle();
    cancel.abort(new Error('client went away'));
    await expect(printing).rejects.toThrow('client went away');
    expect(gated.launched[0]?.closed()).toBe(true);
    const next = renderer.render({ url: URL_, layout: {} });
    await settle();
    expect(gated.launched).toHaveLength(2);
    gated.open(1);
    await next;
  });
});
