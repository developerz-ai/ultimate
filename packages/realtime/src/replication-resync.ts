// Single responsibility: the bus's one control message — "the change stream has a hole no sequence
// can show; every reader re-read now" — its subject, its bytes and its decode. The replicator says
// it when its slot was recreated under a resume position; a sync node answers it as a reconnect.

/**
 * Under `x.change.>`, so every node already subscribed hears it — and on a token no table can
 * spell (`[a-z_][a-z0-9_]*` refuses `-`), so it is never a table's subject. A node that predates it
 * reads no `table` and no `lsn` and drops it, as it drops any payload it cannot parse.
 */
export const RESYNC_SUBJECT = 'x.change.-resync';

export interface ResyncSignal {
  /** The replicator run that said it. */
  readonly producer: string;
  readonly reason: string;
}

export function encodeResync(signal: ResyncSignal): string {
  return JSON.stringify({ resync: true, producer: signal.producer, reason: signal.reason });
}

/** The signal, or `null` for every other payload — a change envelope included. */
export function parseResync(payload: string): ResyncSignal | null {
  // A change envelope never opens with this key: cheap to refuse before parsing every change twice.
  if (!payload.startsWith('{"resync":true')) return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const shape = parsed as { resync?: unknown; producer?: unknown; reason?: unknown };
    if (shape.resync !== true || typeof shape.producer !== 'string') return null;
    return {
      producer: shape.producer,
      reason: typeof shape.reason === 'string' ? shape.reason : 'the change stream has a gap',
    };
  } catch {
    return null;
  }
}
