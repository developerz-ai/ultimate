// The scale ladder's bench claims (plan 101 slice 22): worker throughput, cross-node fan-out, boot
// against file count, the large app's whole boot and the production image's req/s — each figure
// stated on the claims page and the committed result it must equal. Data only;
// `scripts/lib/bench-claims-table.ts` spreads it into `CLAIMS`, so `bun run
// scripts/bench-claims.ts` holds these like every other figure.

import type { BenchClaim } from '../lib/bench-claims-table';

export const RESULTS_WORKERS = 'scripts/bench/results/worker-throughput.json';
export const RESULTS_FANOUT_3 = 'scripts/bench/results/fanout-3-nodes.json';
export const RESULTS_BOOT = 'scripts/bench/results/boot-vs-files.json';
export const RESULTS_HTTP_IMAGE = 'scripts/bench/results/http-prod-image.json';
export const RESULTS_LARGE_APP = 'scripts/bench/results/boot-large-app.json';
export const SCALE_LADDER = 'docs/idea/17-scale-ladder.md';

const workers = (profile: 0 | 1, run: 0 | 1 | 2, label: string, pattern: RegExp): BenchClaim => ({
  label,
  file: RESULTS_WORKERS,
  path: `profiles.${String(profile)}.runs.${String(run)}.claimsPerSecond`,
  format: 'count',
  pattern,
});

export const SCALE_CLAIMS: readonly BenchClaim[] = [
  workers(
    0,
    0,
    'shipped-default claims/s at 1 worker',
    /defaults[^:]*: ([\d,]+) claims\/s at 1 worker/,
  ),
  workers(
    0,
    1,
    'shipped-default claims/s at 4 workers',
    /defaults[^:]*: [\d,]+ claims\/s at 1 worker, ([\d,]+) at 4/,
  ),
  workers(
    0,
    2,
    'shipped-default claims/s at 16 workers',
    /defaults[^:]*: [\d,]+ claims\/s at 1 worker, [\d,]+ at 4, ([\d,]+) at 16/,
  ),
  workers(1, 0, 'tuned claims/s at 1 worker', /tuned[^:]*: ([\d,]+) claims\/s at 1 worker/),
  workers(
    1,
    1,
    'tuned claims/s at 4 workers',
    /tuned[^:]*: [\d,]+ claims\/s at 1 worker, ([\d,]+) at 4/,
  ),
  workers(
    1,
    2,
    'tuned claims/s at 16 workers',
    /tuned[^:]*: [\d,]+ claims\/s at 1 worker, [\d,]+ at 4, ([\d,]+) at 16/,
  ),
  {
    label: 'fan-out subscribers across three nodes',
    file: RESULTS_FANOUT_3,
    path: 'run.subscribers',
    format: 'count',
    pattern: /\*\*([\d,]+) subscribers across 3 `sync` nodes/,
  },
  {
    label: 'fan-out deliveries',
    file: RESULTS_FANOUT_3,
    path: 'run.delivered',
    format: 'count',
    pattern: /apart: \*\*([\d,]+) of [\d,]+ deliveries/,
  },
  {
    label: 'fan-out p50',
    file: RESULTS_FANOUT_3,
    path: 'run.overall.p50Ms',
    format: 'plain',
    pattern: /deliveries\*\*, p50 ([\d.]+) ms/,
  },
  {
    label: 'fan-out p99',
    file: RESULTS_FANOUT_3,
    path: 'run.overall.p99Ms',
    format: 'plain',
    pattern: /deliveries\*\*, p50 [\d.]+ ms, p99 ([\d.]+) ms/,
  },
  {
    label: 'serial module load at 5,000 files',
    file: RESULTS_BOOT,
    path: 'results.2.serialMs',
    format: 'count',
    pattern: /5,000 modules: serial ([\d,]+) ms/,
  },
  {
    label: 'batched module load at 5,000 files',
    file: RESULTS_BOOT,
    path: 'results.2.batchedMs',
    format: 'count',
    pattern: /5,000 modules: serial [\d,]+ ms, batched ([\d,]+) ms/,
  },
  {
    label: 'production image req/s, one web pod',
    file: RESULTS_HTTP_IMAGE,
    path: 'runs.0.rps',
    format: 'count',
    pattern: /One `web` pod: \*\*([\d,]+) req\/s\*\*/,
  },
  {
    label: 'production image p99, one web pod',
    file: RESULTS_HTTP_IMAGE,
    path: 'runs.0.worstP99Ms',
    format: 'plain',
    pattern: /req\/s\*\*, p50 [\d.]+ ms, p99 ([\d.]+) ms/,
  },
  {
    label: 'production image req/s, three web pods',
    file: RESULTS_HTTP_IMAGE,
    path: 'runs.1.rps',
    format: 'count',
    pattern: /Three pods on the same host: ([\d,]+) req\/s/,
  },
  {
    label: 'the large app’s TypeScript file count',
    file: RESULTS_LARGE_APP,
    path: 'app.tsFiles',
    format: 'count',
    pattern: /150 generated resources, \*\*([\d,]+) TypeScript files\*\*/,
  },
  {
    label: 'x dev on the large app, a restart',
    file: RESULTS_LARGE_APP,
    path: 'dev.warm.medianMs',
    format: 'seconds',
    pattern: /`x dev` to the first 200 on `\/`: \*\*([\d.]+) s\*\*/,
  },
  {
    label: 'x dev on the large app, a fresh clone',
    file: RESULTS_LARGE_APP,
    path: 'dev.cold.medianMs',
    format: 'seconds',
    pattern: /with `\.x\/` deleted first ([\d.]+) s/,
  },
  {
    label: 'a web pod from the prebuilt registry',
    file: RESULTS_LARGE_APP,
    path: 'pod.registry.medianMs',
    format: 'seconds',
    pattern: /`web` pod from the prebuilt registry: \*\*([\d.]+) s\*\*/,
  },
  {
    label: 'a web pod scanning instead',
    file: RESULTS_LARGE_APP,
    path: 'pod.scan.medianMs',
    format: 'seconds',
    pattern: /registry moved aside, so the role scans: ([\d.]+) s/,
  },
  // The ladder page cites the headline of each, so a re-run that moves one cannot leave the rung
  // describing a run that never happened.
  {
    label: 'the ladder’s fan-out p99',
    doc: SCALE_LADDER,
    file: RESULTS_FANOUT_3,
    path: 'run.overall.p99Ms',
    format: 'plain',
    pattern: /3 `sync` nodes over NATS: p99 ([\d.]+) ms/,
  },
  {
    label: 'the ladder’s tuned 4-worker claims/s',
    doc: SCALE_LADDER,
    file: RESULTS_WORKERS,
    path: 'profiles.1.runs.1.claimsPerSecond',
    format: 'count',
    pattern: /the queue itself plateaus near ([\d,]+) claims\/s/,
  },
  {
    label: 'the ladder’s one-pod req/s',
    doc: SCALE_LADDER,
    file: RESULTS_HTTP_IMAGE,
    path: 'runs.0.rps',
    format: 'count',
    pattern: /production image, one `web` pod: ([\d,]+) req\/s/,
  },
  {
    label: 'the ladder’s large-app dev boot',
    doc: SCALE_LADDER,
    file: RESULTS_LARGE_APP,
    path: 'dev.warm.medianMs',
    format: 'seconds',
    pattern: /`x dev` to the first 200: ([\d.]+) s/,
  },
  {
    label: 'the ladder’s large-app pod boot',
    doc: SCALE_LADDER,
    file: RESULTS_LARGE_APP,
    path: 'pod.registry.medianMs',
    format: 'seconds',
    pattern: /a `web` pod from the prebuilt registry to the first 200: ([\d.]+) s/,
  },
];
