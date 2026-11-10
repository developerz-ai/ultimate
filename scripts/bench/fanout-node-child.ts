// One `sync` NODE for `fanout-3-nodes.bench.ts`: its own process, its own NATS connection, the
// shipped `ChannelHub` + `SocketRegistry`, and `--subscribers` in-process sockets on one events
// channel topic. Prints `READY` once every socket holds the topic, then `FINAL <json>` with each
// probe's delivery latencies once `--events` probes arrived (or the window closed).
//
//   bun run scripts/bench/fanout-node-child.ts --nats <url> --org <id> --subscribers <n> --events <k>

import { ChannelHub } from '../../packages/realtime/src/channel';
import { clearChannels } from '../../packages/realtime/src/channel-registry';
import type { Transport } from '../../packages/realtime/src/fanout';
import { NatsTransport } from '../../packages/realtime/src/nats-transport';
import { SocketRegistry, SyncSocket, type WsLike } from '../../packages/realtime/src/socket';
import { parseScriptArgs } from '../lib/args';
import { ScriptError } from '../lib/script-error';
import { FANOUT_BUCKET, fanoutChannel, latencyOf, nowMs } from './fanout-shape';

export interface FanoutNodeArgs {
  readonly nats: string;
  readonly org: string;
  readonly subscribers: number;
  readonly events: number;
}

/** The four flags the bench spawns a node with, or the refusal naming them. */
export function fanoutNodeArgs(argv: readonly string[]): FanoutNodeArgs {
  const args = parseScriptArgs(argv);
  const nats = args.flags.get('nats');
  const org = args.flags.get('org');
  const subscribers = Number(args.flags.get('subscribers'));
  const events = Number(args.flags.get('events'));
  if (typeof nats !== 'string' || typeof org !== 'string' || !(subscribers > 0) || !(events > 0)) {
    throw new ScriptError({
      code: 'X_CLI_BAD_FLAG',
      cause:
        'fanout-node-child is spawned by the bench with --nats, --org, --subscribers and --events',
      fix: 'bun run scripts/bench/fanout-3-nodes.bench.ts --subscribers 3000',
    });
  }
  return { nats, org, subscribers, events };
}

export interface FanoutFinal {
  readonly received: number;
  readonly expected: number;
  /** Per probe index, every socket's latency in ms. */
  readonly latencies: readonly (readonly number[])[];
}

export interface FanoutNode {
  /** Settles once every probe reached every socket, or the window closed. */
  readonly final: Promise<FanoutFinal>;
  close(): Promise<void>;
}

/**
 * A node over `transport` holding `subscribers` sockets on the bench topic, every one subscribed
 * before this resolves. Latency is read off the frame TEXT at `send`: no decode on the clock.
 */
export async function fanoutNode(
  transport: Transport,
  input: Omit<FanoutNodeArgs, 'nats'> & { readonly windowMs: number },
): Promise<FanoutNode> {
  const latencies: number[][] = Array.from({ length: input.events }, () => []);
  const expected = input.subscribers * input.events;
  let received = 0;
  const window = Promise.withResolvers<void>();
  const probe: WsLike = {
    send(data: string): number {
      const seen = latencyOf(data, nowMs());
      if (seen !== undefined) {
        latencies[seen.index]?.push(seen.ms);
        received += 1;
        if (received === expected) window.resolve();
      }
      return data.length;
    },
    close: () => undefined,
    subscribe: () => undefined,
    unsubscribe: () => undefined,
    getBufferedAmount: () => 0,
  };
  const channel = fanoutChannel();
  const sockets = new SocketRegistry();
  const hub = new ChannelHub({ transport, sockets });
  for (let i = 0; i < input.subscribers; i += 1) {
    const socket = new SyncSocket({
      ws: probe,
      clientBuildId: 'bench',
      serverBuildId: 'bench',
      actor: null,
    });
    sockets.add(socket);
    await hub.subscribeChannel(socket, {
      kind: 'channel',
      channel: channel.name,
      params: { org: input.org },
    });
  }
  // The window: every probe the publisher sends plus a tail, never forever.
  const timeout = setTimeout(() => window.resolve(), input.windowMs);
  const final = window.promise.then(() => {
    clearTimeout(timeout);
    return { received, expected, latencies };
  });
  return { final, close: () => hub.close() };
}

if (import.meta.main) {
  const args = fanoutNodeArgs(Bun.argv.slice(2));
  const transport = new NatsTransport({ url: args.nats, bucket: FANOUT_BUCKET });
  await transport.connect();
  const node = await fanoutNode(transport, { ...args, windowMs: 30_000 + args.events * 2_000 });
  console.log('READY');
  console.log(`FINAL ${JSON.stringify(await node.final)}`);
  await node.close();
  await transport.close();
  clearChannels();
  process.exit(0);
}
