// The SSR tree walker on a big page: one `<table>` of N rows, five cells each, a component per row
// and a `class`/`href` per cell — the shape an admin list or a data export renders. Reports wall
// time and the heap the render grew by, so a walker that allocates a promise per node shows up.
//
//   bun run scripts/bench/render-html.bench.ts [--json] [--rows=<n>] [--out=<file.json>]

import { heapSize } from 'bun:jsc';
import { escapeHtml } from '../../packages/core/src/html-escape';
import { h } from '../../packages/render/src/jsx';
import { renderToHtml } from '../../packages/render/src/render-html';
import { parseScriptArgs } from '../lib/args';
import { boxFacts } from './http-hello';

interface Row {
  readonly id: number;
  readonly name: string;
  readonly email: string;
  readonly status: string;
  readonly total: number;
}

const rowOf = (id: number): Row => ({
  id,
  name: `Customer <${id}>`,
  email: `c${id}@example.com`,
  status: id % 3 === 0 ? 'active' : 'pending',
  total: id * 7,
});

function RowView(props: { readonly row: Row }): unknown {
  const { row } = props;
  return h(
    'tr',
    { class: 'row', 'data-id': row.id },
    h('td', null, row.id),
    h('td', null, h('a', { href: `/customers/${row.id}` }, row.name)),
    h('td', null, row.email),
    h('td', { class: `status-${row.status}` }, () => row.status),
    h('td', { class: 'num' }, row.total),
  );
}

/**
 * The page under test. Exported so the regression test renders exactly what the bench times.
 * `probe` runs as the tbody's last child — after every row, before the walk returns — and renders
 * nothing, so the markup is the same with or without it.
 */
export function tablePage(rows: number, probe?: () => null): unknown {
  const data: unknown[] = Array.from({ length: rows }, (_, i) => h(RowView, { row: rowOf(i) }));
  if (probe !== undefined) data.push(probe);
  return h('main', null, h('h1', null, 'Customers'), h('table', null, h('tbody', null, data)));
}

/**
 * The same markup with no walker at all: template strings over the same rows, through the same
 * core escaper. The yardstick the walker is held to as a RATIO, timed interleaved with it, so a
 * loaded machine slows both and the test stays a statement about the walker.
 */
export function templateBaseline(rows: number): string {
  let out = '<main><h1>Customers</h1><table><tbody>';
  for (let id = 0; id < rows; id++) {
    const row = rowOf(id);
    out +=
      `<tr class="row" data-id="${row.id}"><td>${row.id}</td>` +
      `<td><a href="/customers/${row.id}">${escapeHtml(row.name)}</a></td>` +
      `<td>${escapeHtml(row.email)}</td><td class="status-${row.status}">${escapeHtml(row.status)}</td>` +
      `<td class="num">${row.total}</td></tr>`;
  }
  return `${out}</tbody></table></main>`;
}

export interface RenderBenchResult {
  readonly rows: number;
  readonly bytes: number;
  /** Best of the timed runs: the walker's cost, with the least scheduler noise. */
  readonly ms: number;
  /** Best template-string run, timed in the same loop. */
  readonly baselineMs: number;
  /** `ms / baselineMs`: what the walker costs over writing the strings by hand. */
  readonly ratio: number;
}

const round = (value: number, places: number): number => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

export async function benchRender(rows: number, runs = 5): Promise<RenderBenchResult> {
  const page = tablePage(rows);
  await renderToHtml(page); // warm the JIT
  templateBaseline(rows);
  let best = Number.POSITIVE_INFINITY;
  let baseline = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    let started = performance.now();
    (await renderToHtml(page)).length;
    best = Math.min(best, performance.now() - started);
    started = performance.now();
    templateBaseline(rows).length; // `.length` flattens the rope, as a response body would
    baseline = Math.min(baseline, performance.now() - started);
  }
  const html = await renderToHtml(page);
  return {
    rows,
    bytes: html.length,
    ms: round(best, 2),
    baselineMs: round(baseline, 2),
    ratio: round(best / baseline, 1),
  };
}

/**
 * How far one render grows the heap, in MiB: live memory plus whatever garbage the collector had not
 * reached yet, so it swings with GC timing (≈50 MiB here, ≈100 under a smaller `forceRAMSize`).
 * The bench reports it; the regression test holds `liveAtEnd`, which does not swing.
 */
export async function heapGrowth(rows: number): Promise<number> {
  const page = tablePage(rows);
  Bun.gc(true);
  const before = heapSize();
  await renderToHtml(page);
  return round((heapSize() - before) / 1024 / 1024, 1);
}

/**
 * What the walk holds LIVE once every row is visited, in MiB: a full collection runs inside the
 * walk, at its last node, so the reading is the output so far plus anything the walker keeps per
 * node — a frame or promise per pending subtree — and no garbage, whatever the GC's timing.
 */
export async function liveAtEnd(rows: number): Promise<number> {
  let peak = 0;
  const page = tablePage(rows, () => {
    Bun.gc(true);
    peak = heapSize();
    return null;
  });
  Bun.gc(true);
  const before = heapSize();
  await renderToHtml(page);
  return round((peak - before) / 1024 / 1024, 1);
}

const HEAP_FLAG = 'heap-only';
const LIVE_FLAG = 'live-only';

function inFreshProcess(flag: string, rows: number): number {
  const run = Bun.spawnSync([process.execPath, import.meta.path, `--${flag}`, `--rows=${rows}`]);
  return Number(run.stdout.toString().trim());
}

/** `heapGrowth` is only true as the first render in a process: earlier garbage would count. */
export const heapInFreshProcess = (rows: number): number => inFreshProcess(HEAP_FLAG, rows);

export const liveInFreshProcess = (rows: number): number => inFreshProcess(LIVE_FLAG, rows);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const asked = args.flags.get('rows');
  const counts = typeof asked === 'string' ? [Number(asked)] : [10_000, 50_000];
  if (args.flags.get(HEAP_FLAG) === true) console.log(await heapGrowth(counts[0] ?? 0));
  else if (args.flags.get(LIVE_FLAG) === true) console.log(await liveAtEnd(counts[0] ?? 0));
  else {
    const results = [];
    for (const rows of counts) {
      results.push({
        ...(await benchRender(rows)),
        heapMiB: heapInFreshProcess(rows),
        liveMiB: liveInFreshProcess(rows),
      });
    }
    const data = { box: boxFacts(Bun.env), results };
    const out = args.flags.get('out');
    if (typeof out === 'string') await Bun.write(out, `${JSON.stringify(data, null, 2)}\n`);
    if (args.json) console.log(JSON.stringify(data, null, 2));
    else
      for (const r of results)
        console.log(
          `${r.rows} rows: ${r.ms} ms (${r.ratio}× a template string), +${r.heapMiB} MiB heap`,
        );
  }
}
