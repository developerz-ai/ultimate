// Shared between the server and the orchestrator/client halves of the 50k-socket forced-restart
// benchmark: the one topic every simulated client subscribes to, and the wire shape of a probe.

import { topic } from '@ultimat3/realtime/server';

export const BENCH_TOPIC = topic('bench', 'room');
export const BENCH_SID = 'bench';

export interface BenchProbeRow {
  readonly seq: number;
}
