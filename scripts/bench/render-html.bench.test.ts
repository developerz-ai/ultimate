// The SSR walker's big-page cost as a regression test (plan 101 slice 14 P1). One `async` frame and
// one `Promise.all` per node made a 50k-row table ~30× a template string and allocate ~150–210 MiB.
// Held as a RATIO of CPU time to a template-string baseline run in the same loop, never as wall-clock
// ms: time spent waiting for a core on a shared machine is no cost of the walker's.

import { describe, expect, test } from 'bun:test';
import { renderToHtml } from '../../packages/render/src/render-html';
import {
  benchRender,
  freshReading,
  liveInFreshProcess,
  tablePage,
  templateBaseline,
} from './render-html.bench';

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

  describe('a fresh-process probe', () => {
    const probe = (stdout: string, success = true, exitedDueToTimeout = false) => ({
      success,
      exitedDueToTimeout,
      stdout: Buffer.from(stdout),
    });

    test('reads the number it printed', () => {
      expect(freshReading('live-only', probe('10.6\n'), 1000)).toBe(10.6);
    });

    test('a probe killed at its deadline is X_SPAWN_TIMED_OUT, never a reading of 0', () => {
      expect(() => freshReading('heap-only', probe('', false, true), 1000)).toThrow(
        /X_SPAWN_TIMED_OUT: the --heap-only probe did not finish within 1000 ms/,
      );
    });

    test('a probe that crashed before printing is refused, never read as 0 MiB', () => {
      expect(() => freshReading('live-only', probe('', false), 1000)).toThrow(/X_BENCH_RUN_FAILED/);
      expect(() => freshReading('live-only', probe('', true), 1000)).toThrow(/X_BENCH_RUN_FAILED/);
      expect(() => freshReading('live-only', probe('oops', true), 1000)).toThrow(
        /X_BENCH_RUN_FAILED/,
      );
    });
  });
});
