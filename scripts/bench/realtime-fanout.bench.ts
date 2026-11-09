// One live-query node holding N windows, every one reading `posts`, fed changes on `comments` —
// a table none of them reads. What each change costs the node: before the registry indexed its
// windows by table (plan 101 R1) every change entered every window's lane, 34.6 ms at 10k (29/s).
//
//   bun run scripts/bench/realtime-fanout.bench.ts [--json] [--windows <n>] [--changes <n>]

import { userActor } from '../../packages/core/src/index';
import { RingChangeBuffer } from '../../packages/realtime/src/change-buffer';
import { type ChangeEvent, formatLsn } from '../../packages/realtime/src/changefeed';
import type { LiveQueryDefinition } from '../../packages/realtime/src/live-contract';
import { LiveQueryRegistry } from '../../packages/realtime/src/live-query';
import { SyncSocket, type WsLike } from '../../packages/realtime/src/socket';
import { parseScriptArgs } from '../lib/args';

export interface FanoutBenchResult {
  readonly windows: number;
  readonly changes: number;
  readonly msPerChange: number;
  readonly changesPerSecond: number;
}

const feed: LiveQueryDefinition = {
  name: 'feed',
  entities: ['posts'],
  snapshot: async () => ({ rows: [{ id: 'r1' }], lsn: formatLsn(1) }),
  visible: () => true,
  matcher: () => ({ entities: ['posts'], match: () => ({ patches: [], refill: false }) }),
};

const quiet: WsLike = {
  send: (data) => data.length,
  close: () => undefined,
  subscribe: () => undefined,
  unsubscribe: () => undefined,
  getBufferedAmount: () => 0,
};

const unrelated = (lsn: number): ChangeEvent => ({
  table: 'comments',
  op: 'update',
  before: { id: 'c1' },
  after: { id: 'c1' },
  lsn: formatLsn(lsn),
  txid: String(lsn),
  orgId: null,
  at: 0,
  write: null,
});

/** A node holding `windows` distinct `(query, input)` windows, one subscriber each. */
export async function fanoutRig(windows: number): Promise<LiveQueryRegistry> {
  const registry = new LiveQueryRegistry({ source: new RingChangeBuffer() }).register(feed);
  for (let i = 0; i < windows; i += 1) {
    const socket = new SyncSocket({
      ws: quiet,
      id: `s${String(i)}`,
      clientBuildId: 'b',
      serverBuildId: 'b',
      actor: userActor({ id: `u${String(i)}`, orgId: 'o1' }),
    });
    await registry.subscribe({ socket, name: 'feed', input: { page: i } });
  }
  return registry;
}

/** `changes` changes on `comments`, one after the other, as the bus hands them over. */
export async function deliverUnrelated(
  registry: LiveQueryRegistry,
  changes: number,
): Promise<void> {
  for (let i = 0; i < changes; i += 1) await registry.deliver(unrelated(i + 2));
}

/** The rig, then `changes` timed. */
export async function benchFanout(windows: number, changes: number): Promise<FanoutBenchResult> {
  const registry = await fanoutRig(windows);
  const started = performance.now();
  await deliverUnrelated(registry, changes);
  const ms = performance.now() - started;
  return {
    windows,
    changes,
    msPerChange: Number((ms / changes).toFixed(4)),
    changesPerSecond: Math.round(changes / (ms / 1000)),
  };
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const windows = Number(args.flags.get('windows') ?? 10_000);
  const changes = Number(args.flags.get('changes') ?? 5_000);
  const result = await benchFanout(windows, changes);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else
    console.log(
      `${result.windows} windows, ${result.changes} unrelated changes: ` +
        `${result.msPerChange} ms/change, ${result.changesPerSecond} changes/s`,
    );
}
