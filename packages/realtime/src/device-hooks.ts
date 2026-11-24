// `onOpen` and `onClose` of a device socket, run beside the socket and never in its path: each in
// a per-socket lane (a close never overtakes its open), as the device's actor, a throw reported and
// nothing more. With `onClose` declared each socket is also on the ledger, so a node that dies
// holding sockets still yields their close events, from whichever node leads the next pass.

import type { Actor, Ctx } from '@ultimat3/core';
import { ctxOf, reportError, runWithContext } from '@ultimat3/core';
import { actorOfRecord, type DeviceLedger, type DeviceRecord, recordActor } from './device-ledger';
import type { DeviceWsData } from './device-upgrade';

/** Who a socket belongs to — what `onFrame`, `onOpen` and `onClose` read. */
export interface DeviceInfo {
  readonly deviceId: string;
  readonly socketId: string;
  readonly tenant: string;
}

export type DeviceOpenHandler = (input: {
  readonly device: DeviceInfo;
  readonly ctx: Ctx;
}) => Promise<void> | void;

export type DeviceCloseHandler = (input: {
  readonly device: DeviceInfo;
  readonly ctx: Ctx;
  /**
   * Why it closed: the node's own reason (`replaced`, `no beat`, `grant expired`, `drain`, the one
   * `disconnect()` was given, …), `disconnected` when the device or its network ended it, and
   * `node lost` when the node holding it stopped beating — then `ctx.actor` carries the actor's
   * kind, id and org only, since roles and facts never leave the node that resolved them.
   */
  readonly reason: string;
}) => Promise<void> | void;

/** The close reason of a socket whose node died with it. */
export const DEVICE_NODE_LOST = 'node lost';

export interface DeviceHooksOptions {
  readonly onOpen?: DeviceOpenHandler | undefined;
  readonly onClose?: DeviceCloseHandler | undefined;
  /** Present exactly when `onClose` is: an app that never reads a close pays no bus write. */
  readonly ledger: DeviceLedger | null;
}

const infoOf = (data: DeviceWsData): DeviceInfo => ({
  deviceId: data.grant.deviceId,
  socketId: data.socketId,
  tenant: data.tenant,
});

export class DeviceHooks {
  readonly #options: DeviceHooksOptions;
  readonly #lanes = new Map<string, Promise<void>>();

  constructor(options: DeviceHooksOptions) {
    this.#options = options;
  }

  /** Lanes still running: what a leak test reads. */
  get pending(): number {
    return this.#lanes.size;
  }

  opened(data: DeviceWsData): void {
    const { ledger } = this.#options;
    const record = { ...infoOf(data), actor: recordActor(data.grant.actor) };
    this.#queue(data.socketId, async () => {
      if (ledger !== null) await this.#guard(ledger.opened(record), 'device.ledger');
      await this.#open(infoOf(data), data.grant.actor);
    });
  }

  closed(data: DeviceWsData, reason: string): void {
    const { ledger } = this.#options;
    this.#queue(data.socketId, async () => {
      if (ledger !== null) await this.#guard(ledger.closed(data.socketId), 'device.ledger');
      await this.#close(infoOf(data), data.grant.actor, reason);
    });
  }

  /**
   * The beat's pass: each held socket's record kept, and written again (an `onOpen` with it) when
   * it was gone; then, on the leading node, a close for each socket a dead node took with it.
   */
  async sweep(held: () => readonly DeviceWsData[], holds: (socketId: string) => boolean) {
    const { ledger } = this.#options;
    if (ledger === null) return;
    await Promise.all(
      held().map(async (data) => {
        if (await ledger.keep(data.socketId)) return;
        if (holds(data.socketId)) this.opened(data);
      }),
    );
    for (const record of await ledger.reap()) this.#lost(record);
  }

  #lost(record: DeviceRecord): void {
    const { socketId, deviceId, tenant } = record;
    this.#queue(socketId, () =>
      this.#close({ deviceId, socketId, tenant }, actorOfRecord(record.actor), DEVICE_NODE_LOST),
    );
  }

  async #open(device: DeviceInfo, actor: Actor): Promise<void> {
    const { onOpen } = this.#options;
    if (onOpen === undefined) return;
    const ctx = ctxOf({ actor });
    await this.#guard(
      (async () => await runWithContext(ctx, () => onOpen({ device, ctx })))(),
      'device.on_open',
    );
  }

  async #close(device: DeviceInfo, actor: Actor, reason: string): Promise<void> {
    const { onClose } = this.#options;
    if (onClose === undefined) return;
    const ctx = ctxOf({ actor });
    await this.#guard(
      (async () => await runWithContext(ctx, () => onClose({ device, ctx, reason })))(),
      'device.on_close',
    );
  }

  /** Appended to the socket's lane; the lane is forgotten once nothing is queued behind it. */
  #queue(socketId: string, work: () => Promise<void>): void {
    const lane = (this.#lanes.get(socketId) ?? Promise.resolve()).then(work);
    this.#lanes.set(socketId, lane);
    void lane.then(() => {
      if (this.#lanes.get(socketId) === lane) this.#lanes.delete(socketId);
    });
  }

  /** A hook or a bus write that fails is reported; the lane, and the socket, go on. */
  async #guard(work: Promise<void>, operation: string): Promise<void> {
    try {
      await work;
    } catch (error) {
      reportError(error, { source: 'realtime', scope: { operation } });
    }
  }
}
