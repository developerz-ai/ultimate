// The open device sockets of one declaration, fleet-wide, in the bus's shared set: what turns a node
// that died holding sockets into close events. A holder writes one record per socket and keeps it on
// its beat; one serving node per pass (the lowest live id, presence's election) reads every record
// and takes the ones whose node stopped beating — each dropped before it is handed back.

import {
  type Actor,
  type ActorKind,
  agentActor,
  anonymousActor,
  isActorKind,
  isJsonObject,
  serviceActor,
  userActor,
} from '@ultimat3/core';
import { parseJson } from './device-wire';
import type { Transport } from './fanout';

/** A node is live while its roster entry is: three beats, the device registration's own window. */
const ROSTER_BEATS = 3;
/**
 * A record outlives its holder's roster entry many times over, so a dead node's sockets are still
 * on the bus when a survivor (or the node's own replacement) leads a pass. Refreshed every beat.
 */
const RECORD_BEATS = 20;

/** Who a socket acted as, as far as another node can rebuild it: identity, never roles or facts. */
export interface DeviceRecordActor {
  readonly kind: ActorKind;
  readonly id: string;
  readonly orgId?: string | undefined;
}

export interface DeviceRecord {
  readonly socketId: string;
  readonly node: string;
  readonly tenant: string;
  readonly deviceId: string;
  readonly actor: DeviceRecordActor;
}

export interface DeviceLedgerOptions {
  readonly transport: Transport;
  readonly path: string;
  readonly nodeId: string;
  readonly heartbeatMs: number;
}

export const recordActor = (actor: Actor): DeviceRecordActor =>
  actor.orgId === undefined
    ? { kind: actor.kind, id: actor.id }
    : { kind: actor.kind, id: actor.id, orgId: actor.orgId };

/** The actor a record names, rebuilt with no role, scope, permission or fact it never carried. */
export function actorOfRecord(actor: DeviceRecordActor): Actor {
  const init = { id: actor.id, orgId: actor.orgId };
  if (actor.kind === 'service') return serviceActor(init);
  if (actor.kind === 'agent') return agentActor(init);
  if (actor.kind === 'anonymous') return anonymousActor();
  return userActor(init);
}

const isText = (value: unknown): value is string => typeof value === 'string';

function parseRecord(socketId: string, value: string): DeviceRecord | undefined {
  const raw = parseJson(value);
  if (!isJsonObject(raw)) return undefined;
  const { node, tenant, deviceId, actor } = raw;
  if (!isText(node) || !isText(tenant) || !isText(deviceId) || !isJsonObject(actor)) {
    return undefined;
  }
  const { kind, id, orgId } = actor;
  if (!isActorKind(kind) || !isText(id) || (orgId !== undefined && !isText(orgId))) {
    return undefined;
  }
  return {
    socketId,
    node,
    tenant,
    deviceId,
    actor: orgId === undefined ? { kind, id } : { kind, id, orgId },
  };
}

export class DeviceLedger {
  readonly #options: DeviceLedgerOptions;
  readonly #recordsKey: string;
  readonly #rosterKey: string;

  constructor(options: DeviceLedgerOptions) {
    this.#options = options;
    this.#recordsKey = `device.open.${JSON.stringify(options.path)}`;
    this.#rosterKey = `device.nodes.${JSON.stringify(options.path)}`;
  }

  /** On the roster before the first socket: a record whose node is absent from it is reaped. */
  async join(): Promise<void> {
    await this.#options.transport.shared.put(
      this.#rosterKey,
      this.#options.nodeId,
      '',
      this.#options.heartbeatMs * ROSTER_BEATS,
    );
  }

  async opened(record: Omit<DeviceRecord, 'node'>): Promise<void> {
    const { socketId, tenant, deviceId, actor } = record;
    await this.#options.transport.shared.put(
      this.#recordsKey,
      socketId,
      JSON.stringify({ node: this.#options.nodeId, tenant, deviceId, actor }),
      this.#recordTtl(),
    );
  }

  /** `false` when the record was gone — reaped, or lost with the bus: the caller writes it again. */
  async keep(socketId: string): Promise<boolean> {
    return await this.#options.transport.shared.touch(
      this.#recordsKey,
      socketId,
      this.#recordTtl(),
    );
  }

  async closed(socketId: string): Promise<void> {
    await this.#options.transport.shared.drop(this.#recordsKey, socketId);
  }

  /**
   * One pass: this node's roster entry renewed, and — when it leads — every record whose node is
   * off the roster, dropped and returned. Two nodes that disagree on the leader both reap; that is
   * a second close event for a socket already gone, never a socket left without one.
   */
  async reap(): Promise<readonly DeviceRecord[]> {
    await this.join();
    const roster = await this.#options.transport.shared.entries(this.#rosterKey);
    const live = new Set(roster.map((entry) => entry.member));
    const leader = [...live, this.#options.nodeId].sort()[0];
    if (leader !== this.#options.nodeId) return [];
    const orphans: DeviceRecord[] = [];
    for (const entry of await this.#options.transport.shared.entries(this.#recordsKey)) {
      const record = parseRecord(entry.member, entry.value);
      if (record === undefined || live.has(record.node)) continue;
      await this.#options.transport.shared.drop(this.#recordsKey, entry.member);
      orphans.push(record);
    }
    return orphans;
  }

  #recordTtl(): number {
    return this.#options.heartbeatMs * RECORD_BEATS;
  }
}
