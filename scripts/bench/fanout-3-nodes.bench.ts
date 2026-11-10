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
import { NatsTransport } from '../../packages/realtime/src/nats-transport';
import { parseScriptArgs } from '../lib/args';
import { ScriptError } from '../lib/script-error';
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
async function lineStarting(
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

export async function benchFanout3(
  nats: string,
  subscribers: number,
  events: number,
  intervalMs: number,
): Promise<FanoutRun> {
  const org = crypto.randomUUID();
  const children = splitAcross(subscribers, NODES).map((count) =>
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
  try {
    await Promise.all(readers.map(({ reader, carry }) => lineStarting(reader, carry, 'READY')));
    await publisher.connect();
    installChannelTransport(publisher);
    const channel = fanoutChannel();
    await Bun.sleep(SETTLE_MS);
    for (let index = 0; index < events; index += 1) {
      await publishChannelEvent(channel, { org }, { probeIndex: index, probeSentAt: nowMs() });
      await Bun.sleep(intervalMs);
    }
    const finals = await Promise.all(
      readers.map(async ({ reader, carry }) => {
        const body: unknown = JSON.parse(await lineStarting(reader, carry, 'FINAL '));
        return body as { received: number; expected: number; latencies: number[][] };
      }),
    );
    const perNode = finals.map((final) => summarise(final.latencies.flat()));
    return {
      nodes: NODES,
      subscribers,
      events,
      delivered: finals.reduce((sum, final) => sum + final.received, 0),
      expected: subscribers * events,
      overall: summarise(finals.flatMap((final) => final.latencies.flat())),
      perNode,
    };
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exited));
    await publisher.close();
  }
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const nats = args.flags.get('nats') ?? Bun.env['TEST_NATS_URL'];
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
  const run = await benchFanout3(nats, subscribers, events, intervalMs);
  const data = { box: boxFacts(Bun.env), intervalMs, run };
  const out = args.flags.get('out');
  if (typeof out === 'string') await Bun.write(out, `${JSON.stringify(data, null, 2)}\n`);
  if (args.json) console.log(JSON.stringify(data, null, 2));
  else {
    console.log(
      `${run.subscribers} subscribers on ${run.nodes} nodes, ${run.events} probes: ${run.delivered}/${run.expected} delivered, p50 ${run.overall.p50Ms} ms, p99 ${run.overall.p99Ms} ms, max ${run.overall.maxMs} ms`,
    );
  }
}
