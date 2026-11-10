// The pure half of `fanout-3-nodes.bench.ts`: the channel every process declares, the clock all of
// them read, the probe a frame carries and the percentiles a run reports. Split from the harness
// so the arithmetic is tested without a NATS server.

import { allow } from '../../packages/policy/src/index';
import { channel } from '../../packages/realtime/src/channel-decl';
import { getChannel } from '../../packages/realtime/src/channel-registry';

/** The presence bucket this bench's transports use — never the `x_presence` an app uses. */
export const FANOUT_BUCKET = 'xbenchfanout';

/**
 * The declaration every process makes: a channel is code, loaded by every role. Declared once per
 * process — the publisher and a node share one when a test runs both in it.
 */
export const fanoutChannel = () =>
  getChannel('benchfanout') ??
  channel('benchfanout', {
    params: ['org'],
    catchUp: { name: 'benchFanoutRead' },
    events: true,
    policy: allow('public'),
  });

/**
 * Epoch ms with sub-ms resolution, comparable ACROSS processes on one box: `timeOrigin` is each
 * process's wall-clock start and `now()` the monotonic offset from it. Never across machines.
 */
export const nowMs = (): number => performance.timeOrigin + performance.now();

const PROBE = /"probeIndex":(\d+),"probeSentAt":([\d.]+)/;

/** The probe a frame carries and how long it took to reach this socket, or `undefined`. */
export function latencyOf(
  frame: string,
  receivedAt: number,
): { index: number; ms: number } | undefined {
  const match = PROBE.exec(frame);
  if (match === null) return undefined;
  return { index: Number(match[1]), ms: receivedAt - Number(match[2]) };
}

export interface LatencySummary {
  readonly deliveries: number;
  readonly p50Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

/** Nearest-rank percentiles, two decimals. An empty list is all zeros, never `NaN`. */
export function summarise(samples: readonly number[]): LatencySummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p: number): number => {
    if (sorted.length === 0) return 0;
    const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return Math.round((sorted[at] ?? 0) * 100) / 100;
  };
  return { deliveries: sorted.length, p50Ms: rank(0.5), p99Ms: rank(0.99), maxMs: rank(1) };
}

/** Subscribers per node: the total split as evenly as whole sockets allow. */
export function splitAcross(total: number, nodes: number): readonly number[] {
  const base = Math.floor(total / nodes);
  return Array.from({ length: nodes }, (_, index) => base + (index < total % nodes ? 1 : 0));
}
