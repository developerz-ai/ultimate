// The node's signature on a live cursor (#1280): `cursor.ids` is client data the gate reads as
// "rows this subscriber holds", so a forged id is handed that row's `delete`. SERVER-ONLY — it
// reads the app's signing secret, and no page module may import it.
//
// Why a signature and not a filter: intersecting the ids with what the policy admits NOW loses the
// designed case — a row really held, revoked while away, must still be withdrawn — and client data
// cannot tell the two apart. A cursor the node signed can.

import { compareFingerprint, keyedFingerprint } from '@ultimat3/core';
import type { LiveCursor } from './cursor';
import { liveTenantOf } from './live-tenant';
import type { Subscriber } from './subscriber-gate';

/** The key purpose: a cursor sig is a MAC under a key no other keyed fingerprint shares. */
const PURPOSE = 'realtime-live-cursor';

/**
 * `signed`: the node minted this sig over exactly this cursor, for this subscriber. `unsigned`: no
 * sig — a client older than the signature. `refused`: a sig is present and is not this cursor's —
 * tampered ids or lsn, another subscriber's or another window's, a rotated secret, or no sig format
 * at all. Only the node mints one, so no honest client ever sends the third.
 */
export type CursorVerdict = 'signed' | 'unsigned' | 'refused';

/**
 * SHA-256 over the SORTED ids as JSON, per ids ARRAY. Sorted, so the same set signs the same in any
 * order; JSON, so two lists that only concatenate alike do not. `advance` hands an update's cursor
 * the array it had, so the common change re-signs a new lsn over a digest already taken — and a
 * copy is another array, so tampered ids are never answered from the cache of the honest ones.
 */
const digests = new WeakMap<readonly string[], string>();

function idsDigest(ids: readonly string[]): string {
  const cached = digests.get(ids);
  if (cached !== undefined) return cached;
  const digest = new Bun.CryptoHasher('sha256')
    .update(JSON.stringify([...ids].sort()))
    .digest('hex');
  digests.set(ids, digest);
  return digest;
}

/**
 * What a sig covers, as one JSON array — fixed positions, so no field can be read as another, and
 * `null` is never the string a client could name an actor. A string and not an object on purpose:
 * this runs per subscriber per change, and `keyedFingerprint` canonicalises an object key by key
 * (18.9 µs against 10.7 µs for this, measured 2026-11-27).
 *
 * `at` is absent on purpose — the client rewrites it on every patch. The subscriber is its actor
 * and tenant, never its `sid`: a reconnect subscribes under a new one. Every anonymous subscriber
 * is one subject, which is what a row policy sees them as too.
 */
function signedFields(cursor: LiveCursor, who: Subscriber): string {
  return JSON.stringify([
    cursor.qid,
    cursor.lsn,
    idsDigest(cursor.ids),
    who.actor === null ? null : who.actor.id,
    liveTenantOf(who.actor),
  ]);
}

/** The cursor as the node hands it out: the same position, signed for the subscriber it is for. */
export function signCursor(cursor: LiveCursor, who: Subscriber): LiveCursor & { sig: string } {
  return { ...cursor, sig: keyedFingerprint(signedFields(cursor, who), PURPOSE) };
}

/** What a cursor a client SENT is worth. Compared in constant time (`compareFingerprint`). */
export function cursorVerdict(cursor: LiveCursor, who: Subscriber): CursorVerdict {
  if (cursor.sig === undefined) return 'unsigned';
  const match = compareFingerprint(cursor.sig, signedFields(cursor, who), PURPOSE);
  // `unverifiable` — another key, or no format this build reads — is refused with a mismatch: the
  // cost is one snapshot after a secret rotation, and trusting it would be the forgery's way in.
  return match === 'match' ? 'signed' : 'refused';
}

/** One cursor a resume was not decided from as signed. Carries no ids: they are the forgery. */
export interface CursorDistrusted {
  readonly qid: string;
  readonly sid: string;
  readonly actorId: string | null;
}

export interface CursorTrustOptions {
  /**
   * `live.cursors_unsigned`. A resume from a cursor with no sig: a client built before the
   * signature. Served as it always was, ids trusted — the count is how an operator sees how many
   * such clients are left before `next` cold-starts them.
   */
  readonly onUnsignedCursor?: (event: CursorDistrusted) => void;
  /**
   * `live.cursors_refused`. A cursor whose sig is not its own, answered with a cold start. No
   * honest client produces one except across a signing-secret rotation, so a steady rate is
   * somebody editing cursors.
   */
  readonly onCursorRefused?: (event: CursorDistrusted) => void;
}

/** Both counters and the one decision behind them. Owned per registry, as `SubscriberGate` is. */
export class CursorTrust {
  readonly #options: CursorTrustOptions;
  #unsigned = 0;
  #refused = 0;

  constructor(options: CursorTrustOptions) {
    this.#options = options;
  }

  /** Resumes from an unsigned cursor since boot. */
  get unsignedCursors(): number {
    return this.#unsigned;
  }

  /** Cursors whose sig did not match since boot, each answered with a cold start. */
  get cursorsRefused(): number {
    return this.#refused;
  }

  /** Whether a resume may be decided from this cursor. `false` is a cold start, never an error. */
  admits(cursor: LiveCursor, who: Subscriber): boolean {
    const verdict = cursorVerdict(cursor, who);
    if (verdict === 'signed') return true;
    const event = { qid: cursor.qid, sid: who.sid, actorId: who.actor?.id ?? null };
    if (verdict === 'unsigned') {
      this.#unsigned += 1;
      this.#options.onUnsignedCursor?.(event);
      return true;
    }
    this.#refused += 1;
    this.#options.onCursorRefused?.(event);
    return false;
  }
}
