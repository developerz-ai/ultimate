// Every bench claim `scripts/bench-claims.ts` holds: which page states it, which committed result
// carries it, the dot path into that result, and the pattern that reads it off the prose. Data only,
// split from the checker at its file ceiling; the checker re-exports these names.

export const CLAIMS_FILE = 'scripts/bench/results/README.md';
export const RESULTS_50K = 'scripts/bench/results/50k-restart.json';
export const RESULTS_10K = 'scripts/bench/results/10k-restart-seq.json';
export const RESULTS_FIRST_HOUR = 'scripts/bench/results/first-hour.json';
export const RESULTS_HTTP_HOME = 'scripts/bench/results/http-hello.json';
export const RESULTS_HTTP_QUERY = 'scripts/bench/results/http-hello-query.json';
export const RESULTS_RENDER = 'scripts/bench/results/render-html.json';
export const RESULTS_SPAN = 'scripts/bench/results/span-overhead.json';
export const COMPARED = 'wiki/Compared.md';

/** How a measured number is spelled in prose. */
export type BenchFormat = 'count' | 'seconds' | 'plain';

export interface BenchClaim {
  /** What the sentence asserts, in the words the fix line will use. */
  readonly label: string;
  /** The page that states it, when that is not `CLAIMS_FILE` — `README.md`, `wiki/Compared.md`. */
  readonly doc?: string;
  readonly file: string;
  /** Dot path into that file's JSON. */
  readonly path: string;
  readonly format: BenchFormat;
  /**
   * One capture group, matched against the prose with whitespace collapsed — the claims wrap across
   * lines, and a pattern that could not cross a newline would report every one of them as vanished.
   */
  readonly pattern: RegExp;
}

/** The first-hour figures, on the claims page and on `wiki/Compared.md` — one JSON, two pages. */
const FIRST_HOUR_CLAIMS: readonly BenchClaim[] = [
  {
    label: 'the scaffold step',
    file: RESULTS_FIRST_HOUR,
    path: 'spread.scaffold ms.median',
    format: 'seconds',
    pattern: /Scaffold ([\d.]+)s, `bun run setup`/,
  },
  {
    label: 'the setup step',
    file: RESULTS_FIRST_HOUR,
    path: 'spread.setup ms.median',
    format: 'seconds',
    pattern: /`bun run setup` ([\d.]+)s with a cold Bun cache/,
  },
  {
    label: 'node_modules after setup',
    file: RESULTS_FIRST_HOUR,
    path: 'spread.nodeModulesMb.median',
    format: 'plain',
    pattern: /leaving (\d+) MB of `node_modules`/,
  },
  {
    label: 'installed packages',
    file: RESULTS_FIRST_HOUR,
    path: 'spread.packages.median',
    format: 'plain',
    pattern: /across (\d+) installed packages/,
  },
  {
    label: 'app files after the first hour',
    file: RESULTS_FIRST_HOUR,
    path: 'spread.appFiles.median',
    format: 'plain',
    pattern: /installed packages and (\d+) app files/,
  },
  {
    label: 'the scaffold step, compared',
    doc: COMPARED,
    file: RESULTS_FIRST_HOUR,
    path: 'spread.scaffold ms.median',
    format: 'seconds',
    pattern: /`create-ultimate` \(29\.4\.0\) \| ([\d.]+) s \|/,
  },
  {
    label: 'the setup step, compared',
    doc: COMPARED,
    file: RESULTS_FIRST_HOUR,
    path: 'spread.setup ms.median',
    format: 'seconds',
    pattern: /`bun run setup`, cold Bun cache \| ([\d.]+) s \|/,
  },
  {
    label: 'node_modules after setup, compared',
    doc: COMPARED,
    file: RESULTS_FIRST_HOUR,
    path: 'spread.nodeModulesMb.median',
    format: 'plain',
    pattern: /`node_modules` after setup \| (\d+) MB \|/,
  },
];

/** `http-hello` against the first-hour scaffold: `/` and one typed read, on both pages. */
const HTTP_CLAIMS: readonly BenchClaim[] = [
  {
    label: "/'s median requests per second",
    file: RESULTS_HTTP_HOME,
    path: 'spread.rps.median',
    format: 'count',
    pattern: /median ([\d,]+) req\/s, p50 [\d.]+ ms, p99 [\d.]+ ms; cold start/,
  },
  {
    label: "/'s median p50",
    file: RESULTS_HTTP_HOME,
    path: 'spread.p50Ms.median',
    format: 'plain',
    pattern: /req\/s, p50 ([\d.]+) ms, p99 [\d.]+ ms; cold start/,
  },
  {
    label: "/'s median p99",
    file: RESULTS_HTTP_HOME,
    path: 'spread.p99Ms.median',
    format: 'plain',
    pattern: /p99 ([\d.]+) ms; cold start/,
  },
  {
    label: 'the cold start to the first 2xx',
    file: RESULTS_HTTP_HOME,
    path: 'coldStartMs',
    format: 'seconds',
    pattern: /cold start to the first 2xx ([\d.]+)s/,
  },
  {
    label: 'resident memory under load',
    file: RESULTS_HTTP_HOME,
    path: 'rssMb',
    format: 'plain',
    pattern: /(\d+) MiB resident/,
  },
  {
    label: "the typed read's median requests per second",
    file: RESULTS_HTTP_QUERY,
    path: 'spread.rps.median',
    format: 'count',
    pattern: /median ([\d,]+) req\/s, p50 [\d.]+ ms, p99 [\d.]+ ms\./,
  },
  {
    label: "the typed read's median p50",
    file: RESULTS_HTTP_QUERY,
    path: 'spread.p50Ms.median',
    format: 'plain',
    pattern: /req\/s, p50 ([\d.]+) ms, p99 [\d.]+ ms\./,
  },
  {
    label: "the typed read's median p99",
    file: RESULTS_HTTP_QUERY,
    path: 'spread.p99Ms.median',
    format: 'plain',
    pattern: /p99 ([\d.]+) ms\./,
  },
  {
    label: "/'s median requests per second, compared",
    doc: COMPARED,
    file: RESULTS_HTTP_HOME,
    path: 'spread.rps.median',
    format: 'count',
    pattern: /concurrency 16 \| median ([\d,]+) req\/s/,
  },
  {
    label: "/'s median p99, compared",
    doc: COMPARED,
    file: RESULTS_HTTP_HOME,
    path: 'spread.p99Ms.median',
    format: 'plain',
    pattern: /concurrency 16 \| median [\d,]+ req\/s, p99 ([\d.]+) ms \|/,
  },
  {
    label: "the typed read's median requests per second, compared",
    doc: COMPARED,
    file: RESULTS_HTTP_QUERY,
    path: 'spread.rps.median',
    format: 'count',
    pattern: /`\/_x\/query\/post-list` \| median ([\d,]+) req\/s/,
  },
  {
    label: "the typed read's median p99, compared",
    doc: COMPARED,
    file: RESULTS_HTTP_QUERY,
    path: 'spread.p99Ms.median',
    format: 'plain',
    pattern: /`\/_x\/query\/post-list` \| median [\d,]+ req\/s, p99 ([\d.]+) ms \|/,
  },
  {
    label: 'the cold start, compared',
    doc: COMPARED,
    file: RESULTS_HTTP_HOME,
    path: 'coldStartMs',
    format: 'seconds',
    pattern: /cold start to the first 2xx \(`x dev`\) \| ([\d.]+) s \|/,
  },
];

/** `render-html.bench.ts`: the 50k-row table, `results.1` (the run writes 10k first). */
const RENDER_CLAIMS: readonly BenchClaim[] = [
  {
    label: 'the 50k-row render, as a multiple of a template string',
    file: RESULTS_RENDER,
    path: 'results.1.ratio',
    format: 'plain',
    pattern: /\*\*([\d.]+)× a template string\*\*/,
  },
  {
    label: 'the 50k-row render',
    file: RESULTS_RENDER,
    path: 'results.1.ms',
    format: 'plain',
    pattern: /same loop \(([\d.]+) ms against [\d.]+ ms\)/,
  },
  {
    label: 'the 50k-row template string',
    file: RESULTS_RENDER,
    path: 'results.1.baselineMs',
    format: 'plain',
    pattern: /same loop \([\d.]+ ms against ([\d.]+) ms\)/,
  },
  {
    label: "the 50k-row render's heap growth",
    file: RESULTS_RENDER,
    path: 'results.1.heapMiB',
    format: 'plain',
    pattern: /heap grew by \*\*([\d.]+) MiB\*\*/,
  },
];

/** One span's cost, unsampled and sampled-with-no-subscriber (plan 101 slice 20, ≤ 1 µs target). */
const SPAN_CLAIMS: readonly BenchClaim[] = [
  {
    label: 'an unsampled child span',
    file: RESULTS_SPAN,
    path: 'results.1.nsPerSpan',
    format: 'plain',
    pattern: /an unsampled child span costs \*\*(\d+) ns\*\*/,
  },
  {
    label: 'an unsampled root span',
    file: RESULTS_SPAN,
    path: 'results.0.nsPerSpan',
    format: 'plain',
    pattern: /an unsampled root \*\*(\d+) ns\*\*/,
  },
  {
    label: 'a sampled span with no subscriber',
    file: RESULTS_SPAN,
    path: 'results.2.nsPerSpan',
    format: 'plain',
    pattern: /a sampled span with no `span\.end` subscriber \*\*(\d+) ns\*\*/,
  },
];

/**
 * Anchored patterns, never a bare search for the digits: `50,000` appears four times in this file,
 * and "the number is somewhere on the page" would pass over a sentence that had been rewritten to
 * say something else about it.
 */
export const CLAIMS: readonly BenchClaim[] = [
  {
    label: "the reachability run's client count",
    file: RESULTS_50K,
    path: 'clients',
    format: 'count',
    pattern: /Reachability, ([\d,]+) clients:/,
  },
  {
    label: 'clients that reconnected after the kill',
    file: RESULTS_50K,
    path: 'restart.reconnect.count',
    format: 'count',
    pattern: /All ([\d,]+) reconnected;/,
  },
  {
    label: 'clients that received a patch in the window',
    file: RESULTS_50K,
    path: 'restart.consistent.count',
    format: 'count',
    pattern: /\*\*([\d,]+)\*\* received a channel patch/,
  },
  {
    label: 'first-delivery p50',
    file: RESULTS_50K,
    path: 'restart.consistent.p50Ms',
    format: 'seconds',
    pattern: /p50 ([\d.]+)s \/ p90/,
  },
  {
    label: 'first-delivery p90',
    file: RESULTS_50K,
    path: 'restart.consistent.p90Ms',
    format: 'seconds',
    pattern: /p90 ([\d.]+)s \/ max/,
  },
  {
    label: 'first-delivery max',
    file: RESULTS_50K,
    path: 'restart.consistent.maxMs',
    format: 'seconds',
    pattern: /\/ max ([\d.]+)s;/,
  },
  {
    label: 'connect attempts the AcceptBudget shed',
    file: RESULTS_50K,
    path: 'restart.shedAttempts',
    format: 'count',
    pattern: /([\d,]+) connect attempts shed/,
  },
  {
    label: "the delivery run's client count",
    file: RESULTS_10K,
    path: 'clients',
    format: 'count',
    pattern: /Delivery, ([\d,]+) clients:/,
  },
  {
    label: 'the probe interval',
    file: RESULTS_10K,
    path: 'probeIntervalMs',
    format: 'plain',
    pattern: /a probe every (\d+)ms/,
  },
  {
    label: 'clients that reconnected in the delivery run',
    file: RESULTS_10K,
    path: 'restart.reconnect.count',
    format: 'count',
    pattern: /all ([\d,]+) reconnected:/,
  },
  {
    label: 'patches received',
    file: RESULTS_10K,
    path: 'seq.received',
    format: 'count',
    pattern: /\*\*([\d,]+) patches received/,
  },
  {
    label: 'observed sequence gaps',
    file: RESULTS_10K,
    path: 'seq.missing',
    format: 'count',
    pattern: /patches received, ([\d,]+) observed sequence gaps/,
  },
  ...FIRST_HOUR_CLAIMS,
  ...HTTP_CLAIMS,
  ...RENDER_CLAIMS,
  ...SPAN_CLAIMS,
];
