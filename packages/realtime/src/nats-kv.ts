// Single responsibility: `TransportSet` over a JetStream KV bucket — the shared, TTL'd keyed sets
// presence lives in. A member is one KV key, so a node that dies stops heartbeating and its members
// expire on the server's own clock; nothing has to be cleaned up by whoever notices the loss.

import type { Clock } from '@ultimat3/core';
import type { TransportSet, TransportSetEntry } from './fanout';
import type { NatsClient } from './nats-client';
import { kvGet, kvLast, kvWrite } from './nats-jetstream';

/** Per-message TTL is expressed in whole seconds, and must never expire before the logical one. */
const TTL_GRACE_SECONDS = 1;

/**
 * A presence key and a member id are user data — a topic name carries dots, a socket id can carry
 * anything — and a subject token may not. base64url over UTF-8 bytes is reversible and lands inside
 * both the subject grammar and the KV key charset, so no name has to be rejected for its spelling.
 */
export function encodeToken(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function decodeToken(token: string): string {
  const padded = token.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

interface StoredValue {
  /** The caller's opaque value. */
  readonly v: string;
  /** The TTL it was written with, so expiry can be recomputed from the server's write time. */
  readonly t: number;
}

const parseStored = (raw: string): StoredValue | undefined => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const shape = parsed as { v?: unknown; t?: unknown };
    if (typeof shape.v !== 'string' || typeof shape.t !== 'number') return undefined;
    return { v: shape.v, t: shape.t };
  } catch {
    return undefined;
  }
};

const ttlHeader = (ttlMs: number): ReadonlyMap<string, string> =>
  new Map([['Nats-TTL', String(Math.ceil(ttlMs / 1_000) + TTL_GRACE_SECONDS)]]);

export interface NatsKvSetOptions {
  /** The live client. Awaited per call: the transport dials lazily and re-dials after a loss. */
  readonly client: () => Promise<NatsClient>;
  readonly bucket: string;
  /** Only the fallback when a reply carries no server timestamp; the server's clock is the truth. */
  readonly clock: Clock;
}

/** Presence's shared state. One KV key per `<set>.<member>`, one JetStream ack per write. */
export class NatsKvSet implements TransportSet {
  readonly #options: NatsKvSetOptions;

  constructor(options: NatsKvSetOptions) {
    this.#options = options;
  }

  async put(key: string, member: string, value: string, ttlMs: number): Promise<void> {
    const stored: StoredValue = { v: value, t: ttlMs };
    await kvWrite(
      await this.#options.client(),
      this.#options.bucket,
      this.#key(key, member),
      JSON.stringify(stored),
      ttlHeader(ttlMs),
    );
  }

  /** `false` when the member had already expired: the caller must re-`put`, which is a re-join. */
  async touch(key: string, member: string, ttlMs: number): Promise<boolean> {
    const record = await kvGet(
      await this.#options.client(),
      this.#options.bucket,
      this.#key(key, member),
    );
    if (record === undefined || record.operation !== undefined) return false;
    const stored = parseStored(record.value);
    if (stored === undefined) return false;
    if (this.#expiresAt(record.writtenAt, stored.t) <= this.#now()) return false;
    await this.put(key, member, stored.v, ttlMs);
    return true;
  }

  /**
   * A tombstone rather than a stream delete: the bucket denies deletes so history cannot be
   * rewritten, and the marker carries the shortest legal TTL so it clears itself straight after.
   */
  async drop(key: string, member: string): Promise<void> {
    await kvWrite(
      await this.#options.client(),
      this.#options.bucket,
      this.#key(key, member),
      '',
      new Map([
        ['KV-Operation', 'DEL'],
        ['Nats-TTL', String(TTL_GRACE_SECONDS)],
      ]),
    );
  }

  async entries(key: string): Promise<readonly TransportSetEntry[]> {
    const records = await kvLast(
      await this.#options.client(),
      this.#options.bucket,
      `${encodeToken(key)}.*`,
    );
    const now = this.#now();
    const live: TransportSetEntry[] = [];
    for (const record of records) {
      if (record.operation !== undefined) continue;
      const stored = parseStored(record.value);
      const member = this.#member(record.key);
      if (stored === undefined || member === undefined) continue;
      const expiresAt = this.#expiresAt(record.writtenAt, stored.t);
      if (expiresAt > now) live.push({ member, value: stored.v, expiresAt });
    }
    return live;
  }

  #key(key: string, member: string): string {
    return `${encodeToken(key)}.${encodeToken(member)}`;
  }

  /**
   * Token `[1]` is the member — `#key` writes exactly two, because `encodeToken` emits no dot.
   * A key this class did not write is skipped rather than read: the bucket may hold anything, and
   * one foreign key must not take the whole presence listing down with it.
   */
  #member(kvKey: string): string | undefined {
    const token = kvKey.split('.')[1];
    if (token === undefined) return undefined;
    try {
      return decodeToken(token);
    } catch {
      return undefined;
    }
  }

  #expiresAt(writtenAt: number | undefined, ttlMs: number): number {
    return (writtenAt ?? this.#now()) + ttlMs;
  }

  #now(): number {
    return this.#options.clock.now().getTime();
  }
}
