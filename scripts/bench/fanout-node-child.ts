// One `sync` NODE for `fanout-3-nodes.bench.ts`: its own process, its own NATS connection, the
// shipped `ChannelHub` + `SocketRegistry`, and `--subscribers` in-process sockets on one events
// channel topic. Prints `READY` once every socket holds the topic, then `FINAL <json>` with each
// probe's delivery latencies once `--events` probes arrived (or the window closed).
//
//   bun run scripts/bench/fanout-node-child.ts --nats <url> --org <id> --subscribers <n> --events <k>

import { ChannelHub } from '../../packages/realtime/src/channel';
import { clearChannels } from '../../packages/realtime/src/channel-registry';
import { NatsTransport } from '../../packages/realtime/src/nats-transport';
import { SocketRegistry, SyncSocket, type WsLike } from '../../packages/realtime/src/socket';
import { parseScriptArgs } from '../lib/args';
import { ScriptError } from '../lib/script-error';
import { FANOUT_BUCKET, fanoutChannel, latencyOf, nowMs } from './fanout-shape';

const args = parseScriptArgs(Bun.argv.slice(2));
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

/** Per probe index, every socket's latency in ms. Read off the frame text: no decode on the clock. */
const latencies: number[][] = Array.from({ length: events }, () => []);
let received = 0;
const window = Promise.withResolvers<void>();

class ProbeWs implements WsLike {
  send(data: string): number {
    const probe = latencyOf(data, nowMs());
    if (probe !== undefined) {
      latencies[probe.index]?.push(probe.ms);
      received += 1;
      if (received === subscribers * events) window.resolve();
    }
    return data.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

const channel = fanoutChannel();
const transport = new NatsTransport({ url: nats, bucket: FANOUT_BUCKET });
await transport.connect();
const sockets = new SocketRegistry();
const hub = new ChannelHub({ transport, sockets });
for (let i = 0; i < subscribers; i += 1) {
  const socket = new SyncSocket({
    ws: new ProbeWs(),
    clientBuildId: 'bench',
    serverBuildId: 'bench',
    actor: null,
  });
  sockets.add(socket);
  await hub.subscribeChannel(socket, { kind: 'channel', channel: channel.name, params: { org } });
}
console.log('READY');

// The window: every probe the publisher sends plus a generous tail, never forever.
const timeout = setTimeout(() => window.resolve(), 30_000 + events * 2_000);
await window.promise;
clearTimeout(timeout);
console.log(`FINAL ${JSON.stringify({ received, expected: subscribers * events, latencies })}`);
await hub.close();
await transport.close();
clearChannels();
process.exit(0);
