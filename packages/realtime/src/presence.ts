// Tier 1: presence. Who is here, where their cursor is, what they are typing.
//
// Presence lives in `transport.shared`, never in a node's heap: when a `sync` node dies its members
// simply stop heartbeating and expire, and every other node already sees the same set. Ephemeral
// state is never modelled as rows — that rule is what keeps presence off the write path entirely.

import { type Clock, systemClock, uuid } from '@ultimat3/core';
import type { ChannelHub, Topic } from './channel';
import type { Transport } from './fanout';
import type { JsonObject } from './json';
import { type Frame, PROTOCOL_VERSION, type PresenceMember } from './sync-protocol';

export const PRESENCE_KEY_PREFIX = 'presence';
/** Separate namespace: the sweep lease is one member per *node*, never one per participant. */
export const PRESENCE_SWEEP_PREFIX = 'presence.sweep';

/**
 * Members carried on one full-set frame. A 5,000-avatar row is not a UI anyone renders, and the
 * full set is 25M member deserializations across one all-hands join storm; the count rides along
 * on the frame so a client can say "and 4,744 others" without ever holding them.
 */
export const DEFAULT_MAX_PRESENCE_MEMBERS = 256;

export interface PresenceOptions {
  readonly transport: Transport;
  /** Optional: without a hub, presence is queryable but silent (no join/leave frames). */
  readonly hub?: ChannelHub;
  readonly clock?: Clock;
  /** Member TTL. Clients should heartbeat at ttl/3 so one lost beat is not a false leave. */
  readonly ttlMs?: number;
  /** Members on a full-set frame. The set itself is never capped — only what is shipped. */
  readonly maxMembers?: number;
  /**
   * This node's identity in the per-topic sweep election. Defaults to a fresh id per registry,
   * which is what a `sync` node wants: an election between processes, never between rooms.
   */
  readonly nodeId?: string;
}

/** One full-set frame's worth of a room, and how big the room actually is. */
export interface PresenceRoster {
  readonly members: readonly PresenceMember[];
  /** Members in the set, whatever was shipped. `total > members.length` means truncated. */
  readonly total: number;
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
  readonly #maxMembers: number;
  readonly #nodeId: string;
  /** Diffing cache only — the truth is always `transport.shared`. Safe to lose. */
  readonly #seen = new Map<string, Set<string>>();

  constructor(options: PresenceOptions) {
    this.#transport = options.transport;
    this.#hub = options.hub;
    this.#clock = options.clock ?? systemClock;
    this.#ttlMs = options.ttlMs ?? 30_000;
    this.#maxMembers = Math.max(1, options.maxMembers ?? DEFAULT_MAX_PRESENCE_MEMBERS);
    this.#nodeId = options.nodeId ?? uuid();
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  /** Recommended client heartbeat interval: one lost beat must not read as a leave. */
  get heartbeatMs(): number {
    return Math.max(1_000, Math.floor(this.#ttlMs / 3));
  }

  async join(name: Topic, input: PresenceInput): Promise<PresenceRoster> {
    const member: PresenceMember = {
      id: input.id,
      actorId: input.actorId,
      meta: input.meta ?? {},
      updatedAt: input.updatedAt ?? this.#clock.now().getTime(),
    };
    await this.#write(name, member);
    this.#track(name).add(member.id);
    await this.#emit(name, 'join', [member]);
    return await this.roster(name);
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

  /**
   * What a full-set frame carries. `list` stays the whole set because the sweep decides who left by
   * differencing it — capping *that* would report every member past the cap as gone.
   */
  async roster(name: Topic): Promise<PresenceRoster> {
    const members = await this.list(name);
    return { members: members.slice(0, this.#maxMembers), total: members.length };
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

  /**
   * Every topic this node has seen, in one pass. Expiry is silent by design — a member whose node
   * died simply stops heartbeating — so with nothing sweeping, the survivors keep rendering a
   * cursor that stopped moving until they reconnect. The `sync` node calls this on an interval;
   * nothing else is in a position to.
   *
   * Why an interval and not a call on demand: `sweep` can only report a member it has already
   * seen, and a member that joined on *another* node is first seen by a sweep. One pass while it
   * is alive is what makes the next pass able to say it left.
   */
  async sweepAll(): Promise<readonly PresenceMember[]> {
    const gone: PresenceMember[] = [];
    for (const name of [...this.#seen.keys()] as Topic[]) {
      // A room nobody is in is not a room. Without this the cache keeps one entry per topic ever
      // subscribed to, for the life of the process, and the sweep walks all of them forever.
      if ((this.#seen.get(name)?.size ?? 0) === 0) {
        this.#seen.delete(name);
        continue;
      }
      if (!(await this.#claimSweep(name))) continue;
      gone.push(...(await this.sweep(name)));
      if ((this.#seen.get(name)?.size ?? 0) === 0) this.#seen.delete(name);
    }
    return gone;
  }

  /**
   * One node per topic per pass reads the full member set. Every node sweeping every room it has
   * ever seen is the same full-set read multiplied by the fleet — twenty nodes reading a
   * 5,000-member set every ten seconds, forever, to produce twenty copies of one `leave` frame.
   *
   * The election needs no compare-and-set the shared store does not have: the lease key is a
   * *keyed set*, so every node's claim is its own member and the winner is simply the lowest id
   * every claimant can see. It is eventually consistent, and the worst case of two nodes reading
   * different views is a duplicate `leave` for a member who has already gone — which is what a
   * `leave` frame means anyway. What it never produces is nobody sweeping: a claim is re-put every
   * pass, and a dead leader's expires within one TTL.
   */
  async #claimSweep(name: Topic): Promise<boolean> {
    const key = `${PRESENCE_SWEEP_PREFIX}.${name}`;
    await this.#transport.shared.put(key, this.#nodeId, '', this.#ttlMs);
    const claimants = await this.#transport.shared.entries(key);
    let leader = this.#nodeId;
    for (const claimant of claimants) if (claimant.member < leader) leader = claimant.member;
    return leader === this.#nodeId;
  }

  /** Full-set frame for a client that just (re)connected — presence has no delta protocol. */
  async syncFrame(name: Topic): Promise<Frame> {
    const roster = await this.roster(name);
    return presenceFrame(name, 'sync', roster.members, roster.total);
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

/**
 * `total` belongs to a **full set** and to nothing else: a `join`/`leave`/`update` frame carries the
 * members that changed, so a count beside them would read as "and the rest were truncated". Absent
 * is a defined answer — the client renders what it was sent.
 */
export function presenceFrame(
  name: Topic,
  op: 'join' | 'leave' | 'update' | 'sync',
  members: readonly PresenceMember[],
  total?: number,
): Frame {
  const base = { type: 'presence', v: PROTOCOL_VERSION, topic: name, op, members } as const;
  return total === undefined ? base : { ...base, total };
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
