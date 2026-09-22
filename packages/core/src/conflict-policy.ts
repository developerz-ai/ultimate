/**
 * The ONE conflict vocabulary: which row survives when an optimistic local write and the server's
 * answer disagree. Row-shaped because the client store is — a merge over a mutator's OUTPUT had
 * nowhere to land, and realtime's rebase silently dropped it. Tier 0 so `action` and `realtime`
 * (both tier 3) name the same type.
 */

/** One record as the client store holds it: a JSON object, keyed by field name. */
export type Row = Readonly<Record<string, unknown>>;

export type ConflictPolicy =
  | 'server-wins'
  | 'last-write-wins'
  | { readonly kind: 'custom'; readonly merge: (local: Row, server: Row) => Row };

export interface ResolveConflictOptions {
  /**
   * The field `last-write-wins` compares — a finite number (epoch ms) the SERVER wrote. Default
   * `updatedAt`, the name realtime's rebase has always read.
   */
  readonly clockField?: string | undefined;
}

/**
 * The surviving row. `last-write-wins` keeps the local row only when its clock is provably newer
 * by the server's own field; a missing or non-numeric clock on either side is no proof, so the
 * server's row stands — the store must never keep a guess over an answer.
 */
export function resolveConflict(
  policy: ConflictPolicy,
  local: Row,
  server: Row,
  options: ResolveConflictOptions = {},
): Row {
  if (typeof policy !== 'string') return policy.merge(local, server);
  if (policy === 'server-wins') return server;
  const field = options.clockField ?? 'updatedAt';
  const localAt = clockOf(local, field);
  const serverAt = clockOf(server, field);
  return localAt !== undefined && serverAt !== undefined && localAt > serverAt ? local : server;
}

function clockOf(row: Row, field: string): number | undefined {
  // Own keys only: a field named `constructor` must not read `Object.prototype`'s.
  if (!Object.hasOwn(row, field)) return undefined;
  const value = row[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
