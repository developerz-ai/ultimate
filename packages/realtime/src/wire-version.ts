// The wire's version and its hard ceilings — a leaf, so every reader (`sync-protocol.ts`,
// `wire-read.ts`, `wire-channel.ts`) shares one number and one table with no import cycle.

import { CURSOR_ID_LIMIT } from './cursor';

/**
 * **3 since 21.0.0** (plan 101), when the socket stopped carrying writes: the `mutate` and
 * `rebase` kinds are deleted, so a client one major behind sends a frame this node refuses with
 * `X_PROTOCOL_VERSION` — its instruction is the rebuild that client needs. Writes are HTTP
 * (`useMutation`). Slice 09's `records` frame reuses this bump; it does not take another.
 *
 * 2 since 2026-08-24, when `cursor.digest` and `cursor.count` were deleted. The version guards
 * incompatibility, never novelty — an additive optional field (`snapshot.entity`) and a removed
 * field read through `list()` (`hello.resume`) both stayed at 1, because `decode` is a whitelist
 * and `list()` answers `[]` for an absent field. `cursor()` is the other kind of reader: it reads
 * through `str`/`num`, which THROW on an absent field, so a cursor without those two is a frame a
 * node or a client one deploy behind cannot read — in BOTH directions, since a cursor rides the
 * client's `subscribe` and the node's `snapshot`. That is exactly what this number refuses, with
 * one instruction instead of a per-frame "field \"digest\" must be a string".
 */
export const PROTOCOL_VERSION = 3;

/**
 * What one frame may contain. Hard ceilings a caller cannot widen — the shape
 * `packages/mcp/src/query-limits.ts` uses — because every one of them is read off a socket the
 * node has already paid for: an unbounded `cursor.ids` was consumed raw into a `Set`, and an
 * `input` of arbitrary depth reached `canonicalJson`, which recurses.
 *
 * Every number clears what this node itself produces, or the decoder refuses its own frames on
 * the next reconnect: `cursorIds` is `CURSOR_ID_LIMIT`, `patches` clears
 * `defaultReconnectBudget.maxPatches`.
 */
export const FRAME_LIMITS = Object.freeze({
  cursorIds: CURSOR_ID_LIMIT,
  patches: 4_096,
  rows: 10_000,
  members: 4_096,
  /** Nesting one `input` may reach. 32 is far past any query's real argument shape. */
  inputDepth: 32,
  /** Values one `input` may hold in total, so a flat-but-enormous object is refused too. */
  inputNodes: 10_000,
  /** Params one channel subscribe may name. A channel declares a handful; a client picks none. */
  channelParams: 16,
});
