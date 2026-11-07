// Addressing ONE connected device from any process: where it is (a TTL'd entry in the bus's shared
// set, written by the node holding its socket) and how a frame reaches it and an answer comes back
// (a subject per node, correlated by id). The transport is the realtime bus every role already
// holds, so a job on a worker reaches a device on a web pod with no second channel.

import { type Clock, logger, systemClock } from '@ultimat3/core';
import { DeviceOfflineError, DeviceRequestTimeoutError } from './device-errors';
import {
  type BusClaim,
  type BusMessage,
  type BusReply,
  type BusRequest,
  decodeBusMessage,
} from './device-wire';
import type { Transport, TransportSubscription } from './fanout';
import type { JsonValue } from './json';
import { encodeToken } from './nats-kv';
import type { Scheduler } from './thundering-herd';

/** What the node holding sockets does with what the bus brings it. */
export interface DeviceBusHandlers {
  /** A request for a device this node may hold; answer through `reply`. */
  onRequest(request: BusRequest): void;
  /** A newer socket for a device opened on `claim.node`. */
  onClaim(claim: BusClaim): void;
}

export interface DeviceBusOptions {
  readonly transport: Transport;
  readonly path: string;
  readonly nodeId: string;
  readonly schedule: Scheduler;
  readonly clock?: Clock | undefined;
  readonly newId: () => string;
}

interface Pending {
  readonly deviceId: string;
  readonly resolve: (frame: JsonValue) => void;
  readonly reject: (error: unknown) => void;
  readonly cancel: () => void;
}

/** Where a device's registration lives. JSON, so no spelling of a tenant or id can collide. */
const locationKey = (path: string, tenant: string, deviceId: string): string =>
  `device.${JSON.stringify([path, tenant, deviceId])}`;

/** The holder's half of a registration: which socket, opened when (the newest one wins). */
interface Location {
  readonly socketId: string;
  readonly since: number;
}

const parseLocation = (value: string): Location | undefined => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { socketId, since } = parsed as { socketId?: unknown; since?: unknown };
    return typeof socketId === 'string' && typeof since === 'number'
      ? { socketId, since }
      : undefined;
  } catch {
    return undefined;
  }
};

export class DeviceBus {
  readonly #options: DeviceBusOptions;
  readonly #clock: Clock;
  readonly #prefix: string;
  /** The bus's own subject, never a `channel()`: no browser subscribes to it. */
  readonly #claimSubject: string;
  readonly #pending = new Map<string, Pending>();
  #subscriptions: TransportSubscription[] = [];

  constructor(options: DeviceBusOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    // The path is declared text and a subject token may not carry `/`: base64url, as presence does.
    this.#prefix = `x.device.${encodeToken(options.path)}`;
    this.#claimSubject = `${this.#prefix}.claim`;
  }

  /** Requests in flight from THIS process — what a leak test reads. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  async start(handlers: DeviceBusHandlers | null): Promise<void> {
    const own = await this.#options.transport.subscribe(
      this.#nodeSubject(this.#options.nodeId),
      (payload) => this.#receive(payload, handlers),
    );
    this.#subscriptions.push(own);
    if (handlers === null) return;
    try {
      this.#subscriptions.push(
        await this.#options.transport.subscribe(this.#claimSubject, (payload) =>
          this.#receive(payload, handlers),
        ),
      );
    } catch (error) {
      // The caller never holds a bus whose start threw, so nothing else would release `own`.
      this.stop();
      throw error;
    }
  }

  /** Every request still waiting is told the device went away: none is left to its deadline. */
  stop(): void {
    for (const subscription of this.#subscriptions) subscription.unsubscribe();
    this.#subscriptions = [];
    for (const [id, pending] of this.#pending) {
      this.#settle(id, pending, { kind: 'offline', id, reason: 'this process stopped' });
    }
  }

  async register(tenant: string, deviceId: string, socketId: string, ttlMs: number): Promise<void> {
    const location: Location = { socketId, since: this.#clock.now().getTime() };
    await this.#options.transport.shared.put(
      locationKey(this.#options.path, tenant, deviceId),
      this.#options.nodeId,
      JSON.stringify(location),
      ttlMs,
    );
    const claim: BusClaim = {
      kind: 'claim',
      tenant,
      deviceId,
      node: this.#options.nodeId,
      socketId,
    };
    await this.#options.transport.publish(this.#claimSubject, JSON.stringify(claim));
  }

  /** The heartbeat's write: kept alive, or written again when the bus had already let it go. */
  async refresh(tenant: string, deviceId: string, socketId: string, ttlMs: number): Promise<void> {
    const key = locationKey(this.#options.path, tenant, deviceId);
    const alive = await this.#options.transport.shared.touch(key, this.#options.nodeId, ttlMs);
    if (alive) return;
    const location: Location = { socketId, since: this.#clock.now().getTime() };
    await this.#options.transport.shared.put(
      key,
      this.#options.nodeId,
      JSON.stringify(location),
      ttlMs,
    );
  }

  async unregister(tenant: string, deviceId: string): Promise<void> {
    await this.#options.transport.shared.drop(
      locationKey(this.#options.path, tenant, deviceId),
      this.#options.nodeId,
    );
  }

  /**
   * One frame to one device and its answer. Located first, so a device nobody holds is
   * `X_DEVICE_OFFLINE` at once; a holder that finds no socket says so, and a device that never
   * answers is `X_DEVICE_REQUEST_TIMEOUT` with its pending entry gone.
   */
  async request(
    tenant: string,
    deviceId: string,
    frame: JsonValue,
    deadlineMs: number,
  ): Promise<JsonValue> {
    const holder = await this.#locate(tenant, deviceId);
    if (holder === null) {
      throw new DeviceOfflineError({
        path: this.#options.path,
        deviceId,
        reason: 'no node holds a socket for it',
      });
    }
    const id = this.#options.newId();
    const answer = new Promise<JsonValue>((resolve, reject) => {
      const cancel = this.#options.schedule(() => {
        if (!this.#pending.delete(id)) return;
        reject(new DeviceRequestTimeoutError({ path: this.#options.path, deviceId, deadlineMs }));
      }, deadlineMs);
      this.#pending.set(id, { deviceId, resolve, reject, cancel });
    });
    const request: BusRequest = {
      kind: 'request',
      id,
      from: this.#options.nodeId,
      tenant,
      deviceId,
      deadlineMs,
      frame,
    };
    try {
      await this.#options.transport.publish(this.#nodeSubject(holder), JSON.stringify(request));
    } catch (error) {
      const pending = this.#pending.get(id);
      this.#pending.delete(id);
      pending?.cancel();
      throw error;
    }
    return await answer;
  }

  /** The holder's answer, onto the requesting node's own subject. */
  async reply(to: string, reply: BusReply): Promise<void> {
    await this.#options.transport.publish(this.#nodeSubject(to), JSON.stringify(reply));
  }

  async #locate(tenant: string, deviceId: string): Promise<string | null> {
    const entries = await this.#options.transport.shared.entries(
      locationKey(this.#options.path, tenant, deviceId),
    );
    let newest: { node: string; since: number } | null = null;
    for (const entry of entries) {
      const location = parseLocation(entry.value);
      if (location === undefined) continue;
      if (newest === null || location.since > newest.since) {
        newest = { node: entry.member, since: location.since };
      }
    }
    return newest?.node ?? null;
  }

  #nodeSubject(node: string): string {
    return `${this.#prefix}.node.${node}`;
  }

  #receive(payload: string, handlers: DeviceBusHandlers | null): void {
    const message: BusMessage | undefined = decodeBusMessage(payload);
    if (message === undefined) {
      // Another build's envelope, or a stray publisher on this prefix: said once per message, and
      // never answered — a reply to a message that could not be read has nobody to go to.
      logger.warn('device.bus_message_unreadable', { path: this.#options.path });
      return;
    }
    if (message.kind === 'request') handlers?.onRequest(message);
    else if (message.kind === 'claim') handlers?.onClaim(message);
    else {
      const pending = this.#pending.get(message.id);
      if (pending !== undefined) this.#settle(message.id, pending, message);
    }
  }

  #settle(id: string, pending: Pending, reply: BusReply): void {
    this.#pending.delete(id);
    pending.cancel();
    if (reply.kind === 'response') pending.resolve(reply.frame);
    else {
      pending.reject(
        new DeviceOfflineError({
          path: this.#options.path,
          deviceId: pending.deviceId,
          reason: reply.reason,
        }),
      );
    }
  }
}
