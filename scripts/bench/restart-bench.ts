// The 50k-socket forced-restart benchmark named in docs/idea/14-roadmap.md's "Open at 1.0.0" and
// docs/idea/03-realtime.md item 1: "milestone 6 ... is a reconnect benchmark: 50k sockets, forced
// `sync` restart, measure time-to-consistent and DB load. Topology is not frozen until that number
// is known." A measurement, not a package — never imported, run standalone:
//
//   bun run scripts/bench/restart-bench.ts --clients 50000 \
//     --out scripts/bench/results/50k-restart.json
//
// That exact command produced the committed result in `results/` — see `results/50k-restart.log`
// for the run's own transcript.
//
// Methodology: boot a real `sync` node (the shipped `createSyncNode`, over the shipped
// `AcceptBudget` at its default 500/s, burst 2000) in its own OS process. Ramp N real WebSocket
// clients against it, split across `--workers` client-shard processes (default: one per CPU minus
// two, floor 2) — see restart-bench-client-worker.ts for why one process cannot hold the whole
// swarm: a single event loop juggling tens of thousands of live sockets and retry timers falls
// behind badly enough to stall the orchestrator's own bookkeeping, which self-inflicts exactly the
// kind of pathological delay this benchmark exists to measure honestly, not manufacture by accident.
// The ramp itself is throttled by the same `AcceptBudget` a production node would apply — readiness
// is read back from the server's own `/bench/ready` socket count, never the shards' self-report, so
// the number this script trusts is the system under test's, not the load generator's. Once ramped,
// SIGKILL the server process (a crash, not a drain — no `reconnect` frame is ever sent) and start a
// fresh one on the same port after a fixed boot gap. Every surviving client's own `backoffDelay` is
// the only thing driving recovery.
//
// TWO numbers, and they answer different questions. `restart.consistent` times each client's FIRST
// channel patch after the kill — reconnect *and* resubscribe *and* one delivery, which is
// REACHABILITY. It cannot see a lost patch, and a channel topic is the one subscription with no
// repair: `SyncSocket.send` drops a frame under backpressure and returns false, `SocketRegistry
// .deliver` and `ChannelHub`'s bridge both discard that answer, and there is no cursor, no
// `desynced` mark and no re-snapshot behind it. So `seq` is the second number
// (restart-bench-seq.ts): every client counts holes in the probe sequence it received on each
// connection, and `seq.missing` is what a lost channel frame looks like.

import { cpus } from 'node:os';
import type { ClientStats } from './restart-bench-client';
import { type BenchReport, type PhaseSummary, summarizeDurations } from './restart-bench-report';
import { summarizeSeq } from './restart-bench-seq';

interface Args {
  readonly clients: number;
  readonly workers: number;
  readonly port: number;
  readonly restartGapMs: number;
  readonly probeIntervalMs: number;
  readonly rampDeadlineMs: number;
  readonly restartDeadlineMs: number;
  readonly out: string | null;
  readonly json: boolean;
}

function defaultWorkers(): number {
  return Math.max(2, cpus().length - 2);
}

function parseArgs(argv: readonly string[]): Args {
  const flag = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    const value = i >= 0 ? argv[i + 1] : undefined;
    return value ?? fallback;
  };
  return {
    clients: Number(flag('clients', '50000')),
    workers: Number(flag('workers', String(defaultWorkers()))),
    port: Number(flag('port', '39191')),
    restartGapMs: Number(flag('restart-gap-ms', '500')),
    probeIntervalMs: Number(flag('probe-interval-ms', '1000')),
    rampDeadlineMs: Number(flag('ramp-deadline-ms', '600000')),
    restartDeadlineMs: Number(flag('restart-deadline-ms', '600000')),
    out: argv.includes('--out') ? flag('out', '') || null : null,
    json: argv.includes('--json'),
  };
}

/** Reads stdout until it prints the line `prefix<content>`, then returns `content`. */
async function readLine(
  stream: ReadableStream<Uint8Array>,
  prefix: string,
  onOther?: (line: string) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream closed before printing "${prefix}"`);
      buffer += decoder.decode(value, { stream: true });
      let newlineAt = buffer.indexOf('\n');
      while (newlineAt >= 0) {
        const line = buffer.slice(0, newlineAt);
        buffer = buffer.slice(newlineAt + 1);
        if (line.startsWith(prefix)) return line.slice(prefix.length);
        if (line.length > 0) onOther?.(line);
        newlineAt = buffer.indexOf('\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// Spawned through these two helpers, and typed as their `ReturnType`, so the `'pipe'` in the
// options keeps narrowing the handles. Annotating a process as the bare `ReturnType<typeof
// Bun.spawn>` widens `stdin` back to `number | FileSink | undefined` and `stdout` to a union that
// no longer includes a readable stream — the writes and reads below then only typecheck by accident.
const spawnServerProcess = (port: number) =>
  Bun.spawn({
    cmd: ['bun', 'run', 'scripts/bench/restart-bench-server.ts', '--port', String(port)],
    stdout: 'pipe',
    stderr: 'inherit',
    cwd: process.cwd(),
  });

const spawnShardProcess = (url: string, count: number, offset: number) =>
  Bun.spawn({
    cmd: [
      'bun',
      'run',
      'scripts/bench/restart-bench-client-worker.ts',
      '--url',
      url,
      '--count',
      String(count),
      '--offset',
      String(offset),
    ],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    cwd: process.cwd(),
  });

async function spawnServer(
  port: number,
): Promise<{ proc: ReturnType<typeof spawnServerProcess>; readyAt: number }> {
  const proc = spawnServerProcess(port);
  await readLine(proc.stdout, 'READY');
  return { proc, readyAt: Date.now() };
}

interface ClientShard {
  readonly proc: ReturnType<typeof spawnShardProcess>;
}

/** Splits `clients` as evenly as possible across `workerCount` shard processes. */
function shardSizes(clients: number, workerCount: number): number[] {
  const base = Math.floor(clients / workerCount);
  const remainder = clients % workerCount;
  return Array.from({ length: workerCount }, (_, i) => base + (i < remainder ? 1 : 0));
}

function spawnClientShards(url: string, clients: number, workerCount: number): ClientShard[] {
  const sizes = shardSizes(clients, workerCount);
  let offset = 0;
  const shards: ClientShard[] = [];
  for (const count of sizes) {
    if (count > 0) shards.push({ proc: spawnShardProcess(url, count, offset) });
    offset += count;
  }
  return shards;
}

/** Tells a shard the measurement window is over and waits for its final per-client stats. */
async function stopShard(shard: ClientShard): Promise<readonly ClientStats[]> {
  shard.proc.stdin.write('stop\n');
  await shard.proc.stdin.end();
  const json = await readLine(shard.proc.stdout, 'FINAL ', (line) =>
    console.error(`[bench]   shard stdout: ${line}`),
  );
  await shard.proc.exited;
  return JSON.parse(json) as readonly ClientStats[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The server's own count of currently-open sockets — the readiness signal this script trusts. */
async function serverSocketCount(port: number): Promise<number | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/bench/ready`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { readonly sockets: number };
    return body.sockets;
  } catch {
    return null;
  }
}

/** Polls `test` until it is true or `deadlineMs` elapses. Returns the elapsed ms either way. */
async function waitUntil(
  deadlineMs: number,
  intervalMs: number,
  test: () => Promise<boolean>,
): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await test()) return Date.now() - start;
    await sleep(intervalMs);
  }
  return Date.now() - start;
}

interface PhaseView {
  readonly requested: number;
  readonly epochMs: number;
  readonly durationMs: number;
  readonly helloOf: (s: ClientStats) => number | null;
  readonly shedOf: (s: ClientStats) => number;
  /** When this client first became consistent, or `null` if the phase publishes no probe at all. */
  readonly consistentOf: (s: ClientStats) => number | null;
}

function summarize(stats: readonly ClientStats[], phase: PhaseView): PhaseSummary {
  const reconnectMs: number[] = [];
  const consistentMs: number[] = [];
  let succeeded = 0;
  let shed = 0;
  for (const s of stats) {
    shed += phase.shedOf(s);
    const hello = phase.helloOf(s);
    if (hello !== null && hello >= phase.epochMs) {
      succeeded += 1;
      reconnectMs.push(hello - phase.epochMs);
      const consistent = phase.consistentOf(s);
      if (consistent !== null && consistent >= phase.epochMs) {
        consistentMs.push(consistent - phase.epochMs);
      }
    }
  }
  return {
    requested: phase.requested,
    succeeded,
    shedAttempts: shed,
    durationMs: phase.durationMs,
    reconnect: summarizeDurations(reconnectMs),
    consistent: summarizeDurations(consistentMs),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = `ws://127.0.0.1:${args.port}/_x/sync`;

  console.error(`[bench] booting server for ${args.clients} clients on :${args.port}`);
  const server1 = await spawnServer(args.port);
  const bootEpoch = server1.readyAt;

  console.error(
    `[bench] spawning ${args.workers} client-shard processes for ${args.clients} clients...`,
  );
  const shards = spawnClientShards(url, args.clients, args.workers);

  console.error("[bench] ramping clients (throttled by the server's own AcceptBudget)...");
  let lastReported = -1;
  const rampMs = await waitUntil(args.rampDeadlineMs, 1_000, async () => {
    const up = await serverSocketCount(args.port);
    if (up !== null && up - lastReported >= 2000) {
      console.error(`[bench]   ${up}/${args.clients} connected (server-reported)`);
      lastReported = up;
    }
    return up !== null && up >= args.clients;
  });
  const preKill = (await serverSocketCount(args.port)) ?? 0;
  console.error(`[bench] ramp done: ${preKill}/${args.clients} alive after ${rampMs}ms`);

  console.error('[bench] forcing restart (SIGKILL, no drain)...');
  const killAt = Date.now();
  server1.proc.kill('SIGKILL');
  await server1.proc.exited;
  await sleep(args.restartGapMs);
  const server2 = await spawnServer(args.port);
  console.error(`[bench] new server ready ${server2.readyAt - killAt}ms after kill`);

  console.error('[bench] probing for consistency while clients reconnect on their own backoff...');
  let seq = 0;
  const probe = setInterval(() => {
    seq += 1;
    void fetch(`http://127.0.0.1:${args.port}/bench/publish?seq=${seq}`, { method: 'POST' }).catch(
      () => {},
    );
  }, args.probeIntervalMs);

  lastReported = -1;
  const restartMs = await waitUntil(args.restartDeadlineMs, 1_000, async () => {
    const up = await serverSocketCount(args.port);
    if (up !== null && up - lastReported >= 2000) {
      console.error(`[bench]   ${up}/${args.clients} reconnected (server-reported)`);
      lastReported = up;
    }
    return up !== null && up >= preKill;
  });
  clearInterval(probe);

  // Killed before the shards are told to stop, not after: a client sitting on an open socket only
  // learns the measurement is over when that socket closes, and nothing closes it while server2 is
  // still alive to answer. Kill it and signal stop together — server death unblocks every client
  // parked in `await closed(ws)`, and the stop signal stops the ones about to retry from opening a
  // new one against a server that is already gone.
  console.error('[bench] stopping client shards and collecting per-client stats...');
  server2.proc.kill('SIGKILL');
  const shardStats = await Promise.all(shards.map(stopShard));
  await server2.proc.exited;
  const stats = shardStats.flat();

  const ramp = summarize(stats, {
    requested: args.clients,
    epochMs: bootEpoch,
    durationMs: rampMs,
    helloOf: (s) => s.firstHelloAt,
    shedOf: (s) => s.shedRamp,
    // The consistency probe only runs after the kill, so the ramp has no delivery to time. Reported
    // as an empty distribution rather than a borrowed one: the restart phase's timestamps belong to
    // the restart phase, and reusing them here is how a ramp summary ends up claiming a
    // time-to-consistent longer than the ramp itself.
    consistentOf: () => null,
  });
  const restart = summarize(stats, {
    requested: args.clients,
    epochMs: killAt,
    durationMs: restartMs,
    helloOf: (s) => s.helloAt,
    shedOf: (s) => s.shedRestart,
    consistentOf: (s) => s.patchAfterOpenAt,
  });

  // Summed across the whole swarm, not per phase: the probe publishes only after the kill, so
  // every message counted here belongs to the restart window by construction.
  const seqSummary = summarizeSeq(stats.map((s) => s.seq));
  console.error(
    `[bench] delivery: ${seqSummary.received} probe messages received by ` +
      `${seqSummary.observers}/${args.clients} clients; ${seqSummary.missing} lost in ` +
      `${seqSummary.gapEvents} gaps on ${seqSummary.clientsWithGaps} clients ` +
      `(${seqSummary.duplicates} duplicates, ${seqSummary.rewinds} publisher rewinds, ` +
      `${seqSummary.malformed} malformed)`,
  );

  const report: BenchReport = {
    measuredAt: new Date().toISOString(),
    clients: args.clients,
    workers: args.workers,
    acceptBudget: { perSecond: 500, burst: 2000 },
    restartGapMs: args.restartGapMs,
    probeIntervalMs: args.probeIntervalMs,
    ramp,
    restart,
    seq: seqSummary,
    notes: [
      'ramp is throttled by the same AcceptBudget the restart recovery is measured under',
      'readiness (ramp done / restart consistent) is read from the server’s own socket count, ' +
        'not the load generator’s self-report',
      'restart.consistent times the FIRST channel patch on the reconnected socket: reconnect + ' +
        'resubscribe + one delivery. That is REACHABILITY, not consistency — a channel topic has ' +
        'no cursor and no re-snapshot, so a patch dropped by backpressure is unrecoverable and a ' +
        'first-delivery timer cannot see one',
      'seq is the delivery half: each client counts holes in the probe sequence it received while ' +
        'subscribed, per connection. seq.missing = 0 means no client observed a lost channel frame',
      'seq.missing is a LOWER BOUND — a hole is only visible between two messages one connection ' +
        'received, so anything lost before the first or after the last is not counted',
      'seq.rewinds, not seq.missing, is where a publisher restart lands: the probe counter resets ' +
        'to zero per server process, and the epoch resets on every socket open',
      'the consistency probe only publishes after the kill, so ramp.consistent is empty by ' +
        'construction — the ramp measures acceptance, the restart measures recovery',
      'DB load proxy: shedAttempts is the count of connect attempts the AcceptBudget refused before ' +
        'accepting in that phase — every one of those never reached a query/snapshot path',
      `client swarm split across ${args.workers} OS processes so the load generator's own event ` +
        'loop is never the bottleneck being measured',
    ],
  };

  console.log(JSON.stringify(report, null, 2));
  if (args.out) await Bun.write(args.out, `${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.main) {
  await main();
}
