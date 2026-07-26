// Tier 1: presence. Who is here, where their cursor is, what they are typing.
//
// Presence lives in `transport.shared`, never in a node's heap: when a `sync` node dies its members
// simply stop heartbeating and expire, and every other node already sees the same set. Ephemeral
// state is never modelled as rows — that rule is what keeps presence off the write path entirely.

import { type Clock, systemClock } from '@ultimat3/core';
import type { ChannelHub, Topic } from './channel';
import type { Transport } from './fanout';
import type { JsonObject } from './json';
import { type Frame, PROTOCOL_VERSION, type PresenceMember } from './sync-protocol';

export const PRESENCE_KEY_PREFIX = 'presence';

export interface PresenceOptions {
  readonly transport: Transport;
  /** Optional: without a hub, presence is queryable but silent (no join/leave frames). */
  readonly hub?: ChannelHub;
  readonly clock?: Clock;
  /** Member TTL. Clients should heartbeat at ttl/3 so one lost beat is not a false leave. */
  readonly ttlMs?: number;
}

export interface PresenceInput {
  readonly id: string;
  readonly actorId: string | null;
  readonly meta?: JsonObject;
  /** Logical time from the member. Ties and older writes are dropped — last write wins. */
  readonly updatedAt?: number;
}

export class PresenceRegistry {
  readonly #transport: Transport;
  readonly #hub: ChannelHub | undefined;
  readonly #clock: Clock;
  readonly #ttlMs: number;
  /** Diffing cache only — the truth is always `transport.shared`. Safe to lose. */
  readonly #seen = new Map<string, Set<string>>();

  constructor(options: PresenceOptions) {
    this.#transport = options.transport;
    this.#hub = options.hub;
    this.#clock = options.clock ?? systemClock;
    this.#ttlMs = options.ttlMs ?? 30_000;
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  /** Recommended client heartbeat interval: one lost beat must not read as a leave. */
  get heartbeatMs(): number {
    return Math.max(1_000, Math.floor(this.#ttlMs / 3));
  }

  async join(name: Topic, input: PresenceInput): Promise<readonly PresenceMember[]> {
    const member: PresenceMember = {
      id: input.id,
      actorId: input.actorId,
      meta: input.meta ?? {},
      updatedAt: input.updatedAt ?? this.#clock.now().getTime(),
    };
    await this.#write(name, member);
    this.#track(name).add(member.id);
    await this.#emit(name, 'join', [member]);
    return await this.list(name);
  }

  /** `false` means the member had already expired: the caller must `join` again, not `heartbeat`. */
  async heartbeat(name: Topic, id: string): Promise<boolean> {
    const alive = await this.#transport.shared.touch(this.#key(name), id, this.#ttlMs);
    if (!alive) this.#track(name).delete(id);
    return alive;
  }

  /** Last-write-wins per member: an out-of-order cursor update is dropped, never merged. */
  async update(name: Topic, input: PresenceInput): Promise<PresenceMember | null> {
    const current = await this.#find(name, input.id);
    const updatedAt = input.updatedAt ?? this.#clock.now().getTime();
    if (current && updatedAt <= current.updatedAt) return current;
    const member: PresenceMember = {
      id: input.id,
      actorId: input.actorId,
      meta: input.meta ?? {},
      updatedAt,
    };
    await this.#write(name, member);
    this.#track(name).add(member.id);
    await this.#emit(name, current ? 'update' : 'join', [member]);
    return member;
  }

  async leave(name: Topic, id: string): Promise<void> {
    const current = await this.#find(name, id);
    await this.#transport.shared.drop(this.#key(name), id);
    this.#track(name).delete(id);
    await this.#emit(
      name,
      'leave',
      current
        ? [current]
        : [{ id, actorId: null, meta: {}, updatedAt: this.#clock.now().getTime() }],
    );
  }

  async list(name: Topic): Promise<readonly PresenceMember[]> {
    const entries = await this.#transport.shared.entries(this.#key(name));
    const members: PresenceMember[] = [];
    for (const entry of entries) {
      const member = parseMember(entry.member, entry.value);
      if (member) members.push(member);
    }
    members.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return members;
  }

  /** Turns TTL expiry into explicit `leave` frames. Called on an interval by the `sync` node. */
  async sweep(name: Topic): Promise<readonly PresenceMember[]> {
    const live = await this.list(name);
    const liveIds = new Set(live.map((member) => member.id));
    const tracked = this.#track(name);
    const gone: PresenceMember[] = [];
    for (const id of tracked) {
      if (!liveIds.has(id)) {
        tracked.delete(id);
        gone.push({ id, actorId: null, meta: {}, updatedAt: this.#clock.now().getTime() });
      }
    }
    for (const id of liveIds) tracked.add(id);
    if (gone.length > 0) await this.#emit(name, 'leave', gone);
    return gone;
  }

  /** Full-set frame for a client that just (re)connected — presence has no delta protocol. */
  async syncFrame(name: Topic): Promise<Frame> {
    return presenceFrame(name, 'sync', await this.list(name));
  }

  #key(name: Topic): string {
    return `${PRESENCE_KEY_PREFIX}.${name}`;
  }

  #track(name: Topic): Set<string> {
    const existing = this.#seen.get(name);
    if (existing) return existing;
    const created = new Set<string>();
    this.#seen.set(name, created);
    return created;
  }

  async #write(name: Topic, member: PresenceMember): Promise<void> {
    const value = JSON.stringify({
      actorId: member.actorId,
      meta: member.meta,
      updatedAt: member.updatedAt,
    });
    await this.#transport.shared.put(this.#key(name), member.id, value, this.#ttlMs);
  }

  async #find(name: Topic, id: string): Promise<PresenceMember | null> {
    const entries = await this.#transport.shared.entries(this.#key(name));
    const entry = entries.find((candidate) => candidate.member === id);
    return entry ? parseMember(entry.member, entry.value) : null;
  }

  async #emit(
    name: Topic,
    op: 'join' | 'leave' | 'update',
    members: readonly PresenceMember[],
  ): Promise<void> {
    if (!this.#hub) return;
    await this.#hub.publishFrame(name, presenceFrame(name, op, members));
  }
}

export function presenceFrame(
  name: Topic,
  op: 'join' | 'leave' | 'update' | 'sync',
  members: readonly PresenceMember[],
): Frame {
  return { type: 'presence', v: PROTOCOL_VERSION, topic: name, op, members };
}

function parseMember(id: string, value: string): PresenceMember | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const shape = parsed as { actorId?: unknown; meta?: unknown; updatedAt?: unknown };
    return {
      id,
      actorId: typeof shape.actorId === 'string' ? shape.actorId : null,
      meta: typeof shape.meta === 'object' && shape.meta !== null ? (shape.meta as JsonObject) : {},
      updatedAt: typeof shape.updatedAt === 'number' ? shape.updatedAt : 0,
    };
  } catch {
    return null;
  }
}
