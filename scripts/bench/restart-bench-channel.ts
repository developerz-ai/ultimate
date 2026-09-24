// The benchmark's one declared channel and the entity its probes are rows of. Since 21.0.0 a channel
// is a `channel()` declaration, never a topic string: the probe is a committed `bench_probes` row,
// the node turns it into a `records` frame with its own seq and epoch, and a frame it drops is
// answered with `replay-gap` — which is what the swarm now counts as repaired or lost.

import { entity, integer, newId, text, uuid } from '@ultimat3/entity';
import { allow } from '@ultimat3/policy';
import { channel } from '@ultimat3/realtime';
import type { ChangeEvent } from '@ultimat3/realtime/server';

export const benchProbes = entity('bench_probes', {
  columns: { id: uuid().primaryKey(), room: text({ max: 40 }), seq: integer() },
});

export const BENCH_ROOM = 'room';

/** `catchUp` names a read the bench never serves: a bench client counts a replay-gap, it re-reads nothing. */
export const BENCH_CHANNEL = channel('bench', {
  params: ['room'],
  catchUp: { name: 'benchProbes' },
  records: [benchProbes],
  // Public on purpose: a bench swarm subscribes as nobody, and a channel with no policy is refused.
  policy: allow('public'),
});

/** The committed change one probe is — what the change feed would hand every `sync` node. */
export function probeChange(seq: number, at: number): ChangeEvent {
  return {
    entity: 'bench_probes',
    op: 'insert',
    before: null,
    after: { id: newId(), room: BENCH_ROOM, seq },
    lsn: seq.toString(16).padStart(16, '0'),
    txid: String(seq),
    orgId: null,
    at,
  };
}
