// The SSR walker's big-page cost as a regression test (plan 101 slice 14 P1). One `async` frame and
// one `Promise.all` per node made a 50k-row table ~30× a template string and allocate ~150–210 MiB.
// Held as a RATIO to a template-string baseline timed in the same loop, never as wall-clock ms: a
// shared CI runner slows both sides alike, and an absolute ceiling there is a flake, not a test.

import { describe, expect, test } from 'bun:test';
import { renderToHtml } from '../../packages/render/src/render-html';
import { benchRender, liveInFreshProcess, tablePage, templateBaseline } from './render-html.bench';

describe('render-html bench', () => {
  test('a 10k-row table costs under 12× writing the strings by hand', async () => {
    const result = await benchRender(10_000);
    expect(result.ratio).toBeLessThan(12);
  });

  test('a 50k-row table stays under 12× a template string', async () => {
    const result = await benchRender(50_000, 3);
    expect(result.ratio).toBeLessThan(12);
  }, 30_000);

  // What the walk holds live once every row is visited, after a forced full collection.
  // `heapSize()` mid-render is live PLUS garbage the collector had not reached — 50 MiB on one
  // box, 100.1 on a CI runner, 6.5 on a third run of the same code — so the ceiling is held on the
  // live set, identical (±0.1) across `BUN_JSC_forceRAMSize` 2–64 GB. 10.6 MiB, about the output
  // itself: the walker flattens its rope every `FLATTEN_EVERY` fragments. Unflattened it held
  // 100.5; a promise per element, as the old walker kept, reads 125.4 (both mutation-checked).
  test('a 50k-row render holds under 16 MiB live at the end of its walk', () => {
    const held = liveInFreshProcess(50_000);
    expect(held).toBeGreaterThan(0);
    expect(held).toBeLessThan(16);
  }, 30_000);

  test('the walker and the baseline write the same page', async () => {
    expect(await renderToHtml(tablePage(300))).toBe(templateBaseline(300));
  });

  test('the page it times is the page it means: rows, escaping, a thunk cell', async () => {
    const html = await renderToHtml(tablePage(2));
    expect(html).toBe(
      '<main><h1>Customers</h1><table><tbody>' +
        '<tr class="row" data-id="0"><td>0</td><td><a href="/customers/0">Customer &lt;0&gt;</a></td>' +
        '<td>c0@example.com</td><td class="status-active">active</td><td class="num">0</td></tr>' +
        '<tr class="row" data-id="1"><td>1</td><td><a href="/customers/1">Customer &lt;1&gt;</a></td>' +
        '<td>c1@example.com</td><td class="status-pending">pending</td><td class="num">7</td></tr>' +
        '</tbody></table></main>',
    );
  });
});
