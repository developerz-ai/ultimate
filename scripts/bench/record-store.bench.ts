// The page record store under the load bank-integrations' panel puts on it (2026-10-29): what one
// live record costs each island reading a projection. Counts, per scenario, the notifications the
// hooks raised (each one a re-run of every effect reading the accessor, i.e. a render), the times
// an answer's `data` came back as a NEW array (what defeats a memo's `===`), and the wall time.
//
//   bun run scripts/bench/record-store.bench.ts [--json]
//
// Scenarios: `board` — 300 runs, the board's `useRecords('runs', { order })` and the alerts island's
// `useRecords('runs', { where: mine })`, 200 frames each moving one run nobody here started.
// `run-page` — the run page's four `useRecords('run_events', { where: runId })` islands plus the
// alerts reader, while the fleet's RUNS frames move other runs. `poll` — a `useQuery` re-read that
// answers the same rows 50 times (REALTIME_MODE=poll, a return to the tab).

import type { SignalFactory } from '../../packages/realtime/src/client-contract';
import { flush, pageHarness, resetPage } from '../../packages/realtime/src/hooks-fixture';
import { pageStore } from '../../packages/realtime/src/page-store';
import { installRealtime } from '../../packages/realtime/src/reactivity';
import { useQuery } from '../../packages/realtime/src/use-query';
import { useRecords } from '../../packages/realtime/src/use-record';

type Row = Readonly<Record<string, unknown>>;
type Accessor = (() => { readonly status: string; readonly data?: readonly Row[] }) & {
  refetch?: () => void;
};

interface Probe {
  bumps: number;
  newArrays: number;
  last: readonly Row[] | undefined;
}

let probes: Probe[] = [];
let current: Probe | undefined;

/** A signal whose setter counts, as Solid's would re-run every reader: one bump, one render. */
const counting: SignalFactory = <T>(initial: T) => {
  let value = initial;
  const probe = current;
  return [
    () => value,
    (next: T) => {
      value = next;
      if (probe !== undefined) probe.bumps++;
    },
  ];
};

function watch(make: () => Accessor): { probe: Probe; read: Accessor } {
  const probe: Probe = { bumps: 0, newArrays: 0, last: undefined };
  current = probe;
  const read = make();
  current = undefined;
  probes.push(probe);
  return { probe, read };
}

/** A render: re-read every accessor whose signal moved since the last one. */
function render(watched: readonly { probe: Probe; read: Accessor }[], seen: number[]): void {
  watched.forEach(({ probe, read }, index) => {
    if (probe.bumps === seen[index]) return;
    seen[index] = probe.bumps;
    const answer = read();
    if (answer.data !== undefined && answer.data !== probe.last) {
      probe.newArrays++;
      probe.last = answer.data;
    }
  });
}

const run = (id: number, by: string): Row => ({
  id: `r${id}`,
  bank: 've.banco',
  status: 'running',
  startedBy: by,
  phase: 'login',
  progress: 0,
  queuedAt: `2026-10-29T10:${String(id % 60).padStart(2, '0')}:00Z`,
});

interface Setup {
  readonly watched: { probe: Probe; read: Accessor }[];
  readonly tick: (i: number) => void | Promise<void>;
  readonly ticks: number;
}

async function scenario(name: string, setup: () => Setup) {
  probes = [];
  pageHarness();
  installRealtime({ signal: counting });
  const { watched, tick, ticks } = setup();
  await flush();
  const seen = watched.map(() => 0);
  // Mounted: every island reads once, as a component does when it renders.
  for (const { probe, read } of watched) probe.last = read().data;
  for (const w of watched) {
    w.probe.bumps = 0;
    w.probe.newArrays = 0;
  }
  seen.fill(0);
  const started = performance.now();
  for (let i = 0; i < ticks; i++) {
    await tick(i);
    render(watched, seen);
  }
  const ms = performance.now() - started;
  const out = {
    name,
    ticks,
    bumps: watched.reduce((sum, w) => sum + w.probe.bumps, 0),
    newArrays: watched.reduce((sum, w) => sum + w.probe.newArrays, 0),
    readers: watched.length,
    perReader: watched.map((w) => w.probe.bumps).join('/'),
    ms: Math.round(ms * 100) / 100,
  };
  resetPage();
  return out;
}

const results = [
  await scenario('board', () => {
    const store = () => pageHarnessStore();
    const s = store();
    const rows: Record<string, Row> = {};
    for (let i = 0; i < 300; i++) rows[`r${i}`] = run(i, i % 3 === 0 ? 'me' : 'other');
    s.adopt('runs', rows);
    const board = watch(() =>
      useRecords<Row>('runs', {
        order: (a, b) => String(b['queuedAt']).localeCompare(String(a['queuedAt'])),
      }),
    );
    const alerts = watch(() => useRecords<Row>('runs', { where: (r) => r['startedBy'] === 'me' }));
    return {
      watched: [board, alerts],
      ticks: 200,
      tick: (i) => {
        s.merge('runs', `r${1 + (i % 99) * 3}`, { progress: i + 1 });
      },
    };
  }),
  await scenario('run-page', () => {
    const s = pageHarnessStore();
    const runs: Record<string, Row> = {};
    for (let i = 0; i < 300; i++) runs[`r${i}`] = run(i, i % 3 === 0 ? 'me' : 'other');
    s.adopt('runs', runs);
    const events: Record<string, Row> = {};
    for (let i = 0; i < 200; i++)
      events[`e${String(i).padStart(4, '0')}`] = { id: `e${i}`, runId: 'r0', kind: 'step', seq: i };
    s.adopt('run_events', events);
    const mine = (r: Row) => r['runId'] === 'r0';
    const islands = [0, 1, 2, 3].map(() =>
      watch(() => useRecords<Row>('run_events', { where: mine })),
    );
    const alerts = watch(() => useRecords<Row>('runs', { where: (r) => r['startedBy'] === 'me' }));
    return {
      watched: [...islands, alerts],
      ticks: 200,
      // 9 of 10 frames are the fleet's (other runs); 1 in 10 an event of THIS run.
      tick: (i) => {
        i % 10 === 9
          ? s.adopt('run_events', {
              [`e${String(200 + i).padStart(4, '0')}`]: {
                id: `x${i}`,
                runId: 'r0',
                kind: 'step',
                seq: 200 + i,
              },
            })
          : s.merge('runs', `r${1 + (i % 99) * 3}`, { progress: i + 1 });
      },
    };
  }),
  await scenario('board-throttled', () => {
    // 10 frames a second for 20 s, the board reading with `throttleMs: 1000` (bank-integrations'
    // hand-written `throttle.ts`, ROWS_MS): a manual timer advanced 100 ms per frame.
    const s = pageHarnessStore();
    const rows: Record<string, Row> = {};
    for (let i = 0; i < 300; i++) rows[`r${i}`] = run(i, 'other');
    s.adopt('runs', rows);
    let now = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const schedule = (fn: () => void, ms: number) => {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return () => {
        timers.splice(timers.indexOf(timer), 1);
      };
    };
    const board = watch(() =>
      useRecords<Row>('runs', {
        order: (a, b) => String(b['queuedAt']).localeCompare(String(a['queuedAt'])),
        throttleMs: 1_000,
        schedule,
      }),
    );
    return {
      watched: [board],
      ticks: 200,
      tick: (i) => {
        s.merge('runs', `r${i % 300}`, { progress: i + 1 });
        now += 100;
        for (const due of timers.filter((timer) => timer.at <= now)) {
          timers.splice(timers.indexOf(due), 1);
          due.fn();
        }
      },
    };
  }),
  await scenario('run-page-big-store', () => {
    // The run page after a long session: 5,000 fleet runs held beside one run's 200 events.
    const s = pageHarnessStore();
    const runs: Record<string, Row> = {};
    for (let i = 0; i < 5_000; i++) runs[`r${i}`] = run(i, 'other');
    s.adopt('runs', runs);
    const events: Record<string, Row> = {};
    for (let i = 0; i < 200; i++)
      events[`e${String(i).padStart(4, '0')}`] = { id: `e${i}`, runId: 'r0', seq: i };
    s.adopt('run_events', events);
    const mine = (r: Row) => r['runId'] === 'r0';
    const islands = [0, 1, 2, 3].map(() =>
      watch(() => useRecords<Row>('run_events', { where: mine })),
    );
    return {
      watched: islands,
      ticks: 200,
      tick: (i) => {
        s.adopt('run_events', {
          [`e${String(200 + i).padStart(4, '0')}`]: { id: `x${i}`, runId: 'r0', seq: 200 + i },
        });
      },
    };
  }),
  await scenario('poll', () => {
    const s = pageHarnessStore();
    const keys = Array.from({ length: 50 }, (_, i) => `r${i}`);
    const rows: Record<string, Row> = {};
    for (const key of keys) rows[key] = run(Number(key.slice(1)), 'me');
    s.adopt('runs', rows);
    // Every re-read answers the same 50 rows: nothing on screen moves.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: Object.values(rows), records: { runs: rows } }), {
        status: 200,
        headers: { 'x-ultimate-records': '1' },
      })) as unknown as typeof fetch;
    const q = watch(() => useQuery<Row>({ name: 'listRuns', entity: 'runs' }, {}));
    return {
      watched: [q],
      ticks: 50,
      tick: async () => {
        q.read.refetch?.();
        await flush();
      },
    };
  }),
];

function pageHarnessStore() {
  return pageStore('bench');
}

if (process.argv.includes('--json')) console.log(JSON.stringify(results));
else console.table(results);
