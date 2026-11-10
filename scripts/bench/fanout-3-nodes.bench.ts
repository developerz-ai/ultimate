#!/usr/bin/env bun
// Cross-node fan-out latency over a real nats-server: three `sync` node PROCESSES (each the shipped
// `ChannelHub` + `SocketRegistry` on its own NATS connection) hold `--subscribers` sockets between
// them on one events channel topic; a fourth process — a worker's half, the bus and nothing else —
// publishes `--events` probes. Latency is publish to the socket's `send`, per socket per probe.
//
// The sockets are in-process `WsLike`s, not real WebSockets: this measures the bus and the node's
// fan-out, not the kernel's TCP stack or a browser — the restart bench covers real sockets.
//
//   bun run scripts/bench/fanout-3-nodes.bench.ts [--nats nats://…] [--subscribers 10000]
//     [--events 20] [--interval-ms 250] [--out <file.json>] [--json]
//
// `--nats` defaults to `TEST_NATS_URL` (`docker/test-services.env`).

import {
  installChannelTransport,
  publishChannelEvent,
} from '../../packages/realtime/src/channel-publish';
import type { Transport } from '../../packages/realtime/src/fanout';
import { NatsTransport } from '../../packages/realtime/src/nats-transport';
import { parseScriptArgs } from '../lib/args';
import { ScriptError } from '../lib/script-error';
import type { FanoutFinal } from './fanout-node-child';
import {
  FANOUT_BUCKET,
  fanoutChannel,
  type LatencySummary,
  nowMs,
  splitAcross,
  summarise,
} from './fanout-shape';
import { boxFacts, readCount } from './http-hello';

const CHILD = Bun.fileURLToPath(new URL('./fanout-node-child.ts', import.meta.url));
const NODES = 3;
/** Long enough for the three nodes' NATS subscriptions to reach the server before the first probe. */
const SETTLE_MS = 1_000;
/** A node's whole life: its own window closes well before this; past it the node hung. */
const CHILD_DEADLINE_MS = 10 * 60_000;

const failed = (cause: string): ScriptError =>
  new ScriptError({
    code: 'X_BENCH_RUN_FAILED',
    cause,
    fix: 'docker compose -f docker/docker-compose.test.yml up -d --wait nats && bun run scripts/bench/fanout-3-nodes.bench.ts --subscribers 3000',
  });

/** Lines of a child's stdout, until one starts with `prefix`; returns the rest of that line. */
export async function lineStarting(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  carry: { buffer: string },
  prefix: string,
): Promise<string> {
  const decoder = new TextDecoder();
  for (;;) {
    let newline = carry.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = carry.buffer.slice(0, newline);
      carry.buffer = carry.buffer.slice(newline + 1);
      if (line.startsWith(prefix)) return line.slice(prefix.length);
      newline = carry.buffer.indexOf('\n');
    }
    const { value, done } = await reader.read();
    if (done) throw failed(`a node process exited before it printed ${prefix.trim()}`);
    carry.buffer += decoder.decode(value, { stream: true });
  }
}

export interface FanoutRun {
  readonly nodes: number;
  readonly subscribers: number;
  readonly events: number;
  readonly delivered: number;
  readonly expected: number;
  readonly overall: LatencySummary;
  readonly perNode: readonly LatencySummary[];
}

/** What a run stands on: the nodes, already subscribed, and a connected publisher. */
export interface FanoutRig {
  /** Each node's final, once its window closes. */
  readonly finals: () => Promise<readonly FanoutFinal[]>;
  readonly publisher: Transport;
  close(): Promise<void>;
}

/** The production rig: one child process per node over NATS, and a fourth connection publishing. */
export async function natsRig(
  nats: string,
  org: string,
  counts: readonly number[],
  events: number,
): Promise<FanoutRig> {
  const children = counts.map((count) =>
    Bun.spawn(
      [
        'bun',
        CHILD,
        '--nats',
        nats,
        '--org',
        org,
        '--subscribers',
        String(count),
        '--events',
        String(events),
      ],
      { stdout: 'pipe', stderr: 'inherit', timeout: CHILD_DEADLINE_MS },
    ),
  );
  const readers = children.map((child) => ({
    reader: (child.stdout as ReadableStream<Uint8Array>).getReader(),
    carry: { buffer: '' },
  }));
  const publisher = new NatsTransport({ url: nats, bucket: FANOUT_BUCKET });
  const close = async (): Promise<void> => {
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exited));
    await publisher.close();
  };
  try {
    await Promise.all(readers.map(({ reader, carry }) => lineStarting(reader, carry, 'READY')));
    await publisher.connect();
  } catch (error) {
    await close();
    throw error;
  }
  return {
    publisher,
    close,
    finals: () =>
      Promise.all(
        readers.map(async ({ reader, carry }) => {
          const body: unknown = JSON.parse(await lineStarting(reader, carry, 'FINAL '));
          return body as FanoutFinal;
        }),
      ),
  };
}

/** The figure a run reports, from every node's final. */
export function fanoutRunOf(
  finals: readonly FanoutFinal[],
  subscribers: number,
  events: number,
): FanoutRun {
  return {
    nodes: finals.length,
    subscribers,
    events,
    delivered: finals.reduce((sum, final) => sum + final.received, 0),
    expected: subscribers * events,
    overall: summarise(finals.flatMap((final) => final.latencies.flat())),
    perNode: finals.map((final) => summarise(final.latencies.flat())),
  };
}

export interface FanoutInput {
  readonly subscribers: number;
  readonly events: number;
  readonly intervalMs: number;
  /** How long the nodes' subscriptions get to reach the bus before the first probe. */
  readonly settleMs?: number;
}

/** `events` probes through `rig.publisher`, `intervalMs` apart, then every node's latencies. */
export async function benchFanout3(
  input: FanoutInput,
  rig: (org: string, counts: readonly number[]) => Promise<FanoutRig>,
): Promise<FanoutRun> {
  const org = crypto.randomUUID();
  const built = await rig(org, splitAcross(input.subscribers, NODES));
  try {
    installChannelTransport(built.publisher);
    const channel = fanoutChannel();
    await Bun.sleep(input.settleMs ?? SETTLE_MS);
    for (let index = 0; index < input.events; index += 1) {
      await publishChannelEvent(channel, { org }, { probeIndex: index, probeSentAt: nowMs() });
      await Bun.sleep(input.intervalMs);
    }
    return fanoutRunOf(await built.finals(), input.subscribers, input.events);
  } finally {
    await built.close();
  }
}

/** The flags, or the refusal naming them. `--nats` falls back to `TEST_NATS_URL`. */
export function fanoutArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
) {
  const args = parseScriptArgs(argv);
  const nats = args.flags.get('nats') ?? env['TEST_NATS_URL'];
  const subscribers = readCount(args.flags.get('subscribers'), 10_000, {
    flag: 'subscribers',
    min: NODES,
    max: 300_000,
  });
  const events = readCount(args.flags.get('events'), 20, { flag: 'events', min: 1, max: 1_000 });
  const intervalMs = readCount(args.flags.get('interval-ms'), 250, {
    flag: 'interval-ms',
    min: 10,
    max: 10_000,
  });
  if (
    typeof nats !== 'string' ||
    typeof subscribers !== 'number' ||
    typeof events !== 'number' ||
    typeof intervalMs !== 'number'
  ) {
    throw new ScriptError({
      code: 'X_CLI_BAD_FLAG',
      cause:
        'fanout-3-nodes needs a NATS url (--nats or TEST_NATS_URL) and whole --subscribers, --events and --interval-ms',
      fix: 'bun run scripts/bench/fanout-3-nodes.bench.ts --nats nats://127.0.0.1:4222 --subscribers 10000',
    });
  }
  const out = args.flags.get('out');
  return {
    nats,
    subscribers,
    events,
    intervalMs,
    out: typeof out === 'string' ? out : undefined,
    json: args.json,
  };
}

/** The report a run prints: the whole JSON, or one line. */
export function fanoutReport(run: FanoutRun, intervalMs: number, json: boolean): string {
  if (json) return JSON.stringify({ box: boxFacts(Bun.env), intervalMs, run }, null, 2);
  return `${run.subscribers} subscribers on ${run.nodes} nodes, ${run.events} probes: ${run.delivered}/${run.expected} delivered, p50 ${run.overall.p50Ms} ms, p99 ${run.overall.p99Ms} ms, max ${run.overall.maxMs} ms`;
}

if (import.meta.main) {
  const args = fanoutArgs(Bun.argv.slice(2), Bun.env);
  const run = await benchFanout3(args, (org, counts) =>
    natsRig(args.nats, org, counts, args.events),
  );
  const data = { box: boxFacts(Bun.env), intervalMs: args.intervalMs, run };
  if (args.out !== undefined) await Bun.write(args.out, `${JSON.stringify(data, null, 2)}\n`);
  console.log(fanoutReport(run, args.intervalMs, args.json));
}
