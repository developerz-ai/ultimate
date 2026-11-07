// The device sockets ONE node holds: open, frames in (in a lane, bounded), requests out, the beat
// and expiry sweep, and the drain. The bus side — where a device is, and how a request from
// another process reaches this one — is `device-bus.ts`; this file answers what arrives.

import type { Clock, Ctx } from '@ultimat3/core';
import { ctxOf, isUltimateError, reportError, runWithContext } from '@ultimat3/core';
import { CLOSE } from './close-codes';
import type { DeviceBus, DeviceBusHandlers } from './device-bus';
import { DeviceFrameTooLargeError } from './device-errors';
import type { DeviceWsData } from './device-upgrade';
import {
  type BusClaim,
  type BusRequest,
  bytesOverLimit,
  DEVICE_FRAME_MAX_BYTES,
  type DeviceOutbound,
  decodeDeviceFrame,
} from './device-wire';
import type { JsonValue } from './json';
import type { PrincipalSockets } from './principal-sockets';
import { drainPlan, type Rng, reconnectFrame, type Scheduler } from './thundering-herd';

/** The socket as much as this file touches it — Bun's `ServerWebSocket<DeviceWsData>` fits. */
export interface DeviceWs {
  readonly data: DeviceWsData;
  /** Bun's answer: bytes written, `-1` queued under backpressure, `0` dropped. */
  send(data: string): number;
  close(code?: number, reason?: string): void;
}

/** Who sent a frame — what `onFrame` reads alongside it. */
export interface DeviceInfo {
  readonly deviceId: string;
  readonly socketId: string;
  readonly tenant: string;
}

export type DeviceFrameHandler = (input: {
  readonly frame: JsonValue;
  readonly device: DeviceInfo;
  readonly ctx: Ctx;
}) => Promise<JsonValue | undefined> | JsonValue | undefined;

/** Frames queued behind `onFrame` on one socket before the device is told it is too fast. */
export const DEVICE_FRAME_QUEUE_MAX = 32;
/** Requests one device may hold unanswered on this node; past it the next is answered offline. */
export const DEVICE_REQUESTS_OUTSTANDING_MAX = 256;
/** A device that is silent for this many beats is gone. */
const SILENT_BEATS = 2;
/** The registration outlives a beat this many times over, so one slow write is never a vanish. */
const REGISTRATION_BEATS = 3;

interface Held {
  readonly ws: DeviceWs;
  lastSeen: number;
  lane: Promise<void>;
  queued: number;
  /** Request id → the requesting node and when this node stops waiting for the device. */
  readonly requests: Map<string, { readonly from: string; readonly until: number }>;
}

export interface DeviceHostOptions {
  readonly path: string;
  readonly heartbeatMs: number;
  readonly onFrame: DeviceFrameHandler;
  readonly bus: DeviceBus;
  readonly principals: PrincipalSockets;
  readonly clock: Clock;
  readonly rng: Rng;
  readonly schedule: Scheduler;
}

/** A device's key on this node: tenant and id together, never one without the other. */
const deviceKey = (tenant: string, deviceId: string): string => JSON.stringify([tenant, deviceId]);

export class DeviceHost implements DeviceBusHandlers {
  readonly #options: DeviceHostOptions;
  readonly #held = new Map<string, Held>();
  readonly #byDevice = new Map<string, string>();

  constructor(options: DeviceHostOptions) {
    this.#options = options;
  }

  get count(): number {
    return this.#held.size;
  }

  open(ws: DeviceWs): void {
    const { socketId, tenant, grant } = ws.data;
    const key = deviceKey(tenant, grant.deviceId);
    // One socket per device: the newest wins here and, through the claim, on every other node.
    const previous = this.#byDevice.get(key);
    if (previous !== undefined) this.#held.get(previous)?.ws.close(CLOSE.policy, 'replaced');
    this.#held.set(socketId, {
      ws,
      lastSeen: this.#options.clock.monotonic(),
      lane: Promise.resolve(),
      queued: 0,
      requests: new Map(),
    });
    this.#byDevice.set(key, socketId);
    this.#send(ws, {
      type: 'hello',
      heartbeatMs: this.#options.heartbeatMs,
      maxFrameBytes: DEVICE_FRAME_MAX_BYTES,
    });
    this.#background(
      this.#options.bus.register(tenant, grant.deviceId, socketId, this.#registrationTtl()),
      'device.register',
    );
  }

  message(ws: DeviceWs, message: string | Uint8Array): void {
    const held = this.#held.get(ws.data.socketId);
    if (held === undefined) return;
    if (typeof message !== 'string') {
      ws.close(1003, 'text frames only');
      return;
    }
    // Bun's `maxPayloadLength` refuses first; this is the same limit for a host that applied none.
    if (bytesOverLimit(message) !== null) {
      ws.close(1009, 'X_DEVICE_FRAME_TOO_LARGE');
      return;
    }
    held.lastSeen = this.#options.clock.monotonic();
    const frame = decodeDeviceFrame(message);
    if (frame === undefined) {
      ws.close(CLOSE.policy, 'X_PROTOCOL_VERSION');
      return;
    }
    if (frame.type === 'response') {
      const asked = held.requests.get(frame.id);
      if (asked === undefined) return;
      held.requests.delete(frame.id);
      this.#background(
        this.#options.bus.reply(asked.from, { kind: 'response', id: frame.id, frame: frame.frame }),
        'device.reply',
      );
    } else if (frame.type === 'frame') this.#enqueue(held, frame.frame);
  }

  close(ws: DeviceWs): void {
    const { socketId, tenant, grant } = ws.data;
    const held = this.#held.get(socketId);
    this.#options.principals.release(socketId);
    if (held === undefined) return;
    this.#held.delete(socketId);
    for (const [id, asked] of held.requests)
      this.#offline(asked.from, id, 'the device disconnected');
    const key = deviceKey(tenant, grant.deviceId);
    if (this.#byDevice.get(key) !== socketId) return;
    this.#byDevice.delete(key);
    this.#background(this.#options.bus.unregister(tenant, grant.deviceId), 'device.unregister');
  }

  onRequest(request: BusRequest): void {
    const socketId = this.#byDevice.get(deviceKey(request.tenant, request.deviceId));
    const held = socketId === undefined ? undefined : this.#held.get(socketId);
    if (held === undefined) {
      this.#offline(request.from, request.id, 'no socket for it on the node it was registered on');
      return;
    }
    if (held.requests.size >= DEVICE_REQUESTS_OUTSTANDING_MAX) {
      this.#offline(
        request.from,
        request.id,
        `it holds ${DEVICE_REQUESTS_OUTSTANDING_MAX} unanswered requests`,
      );
      return;
    }
    if (!this.#send(held.ws, { type: 'request', id: request.id, frame: request.frame })) {
      this.#offline(request.from, request.id, 'its socket dropped the request frame');
      return;
    }
    const until = this.#options.clock.monotonic() + request.deadlineMs;
    held.requests.set(request.id, { from: request.from, until });
  }

  onClaim(claim: BusClaim): void {
    const socketId = this.#byDevice.get(deviceKey(claim.tenant, claim.deviceId));
    if (socketId === undefined || socketId === claim.socketId) return;
    this.#held.get(socketId)?.ws.close(CLOSE.policy, 'replaced');
  }

  /** One pass: silent and expired sockets closed, live ones re-registered, stale requests forgotten. */
  sweep(): void {
    const now = this.#options.clock.monotonic();
    const wall = this.#options.clock.now().getTime();
    const silentAfter = this.#options.heartbeatMs * SILENT_BEATS;
    for (const held of this.#held.values()) {
      const { grant, tenant, socketId } = held.ws.data;
      if (now - held.lastSeen > silentAfter) {
        held.ws.close(CLOSE.idle, 'no beat');
        continue;
      }
      if (grant.expiresAt !== undefined && !(grant.expiresAt > wall)) {
        held.ws.close(CLOSE.policy, 'grant expired');
        continue;
      }
      for (const [id, asked] of held.requests) if (asked.until <= now) held.requests.delete(id);
      this.#background(
        this.#options.bus.refresh(tenant, grant.deviceId, socketId, this.#registrationTtl()),
        'device.refresh',
      );
    }
  }

  /** Every socket told when to come back (slots across `spreadMs`), then the grace, then closed. */
  async drain(options: { graceMs: number; spreadMs: number }): Promise<void> {
    const held = [...this.#held.values()];
    const plan = drainPlan(
      held.map((entry) => entry.ws.data.socketId),
      { spreadMs: options.spreadMs, rng: this.#options.rng },
    );
    for (const entry of plan) {
      const socket = this.#held.get(entry.socketId);
      if (socket !== undefined) this.#send(socket.ws, reconnectFrame(entry.afterMs, 'drain'));
    }
    if (options.graceMs > 0 && this.#held.size > 0) {
      await new Promise<void>((resolve) => this.#options.schedule(resolve, options.graceMs));
    }
    // Closed, not removed: each `close` callback releases its slot, its requests and its entry.
    for (const entry of [...this.#held.values()]) entry.ws.close(CLOSE.goingAway, 'drain');
  }

  #enqueue(held: Held, frame: JsonValue): void {
    if (held.queued >= DEVICE_FRAME_QUEUE_MAX) {
      held.ws.close(CLOSE.policy, 'X_FRAME_RATE_LIMIT');
      return;
    }
    held.queued += 1;
    held.lane = held.lane.then(async () => {
      try {
        await this.#handle(held, frame);
      } finally {
        held.queued -= 1;
      }
    });
  }

  async #handle(held: Held, frame: JsonValue): Promise<void> {
    const { grant, socketId, tenant } = held.ws.data;
    const device: DeviceInfo = { deviceId: grant.deviceId, socketId, tenant };
    const ctx = ctxOf({ actor: grant.actor });
    try {
      const answer = await runWithContext(ctx, () => this.#options.onFrame({ frame, device, ctx }));
      if (answer === undefined || !this.#held.has(socketId)) return;
      const text = JSON.stringify({ type: 'frame', frame: answer });
      const over = bytesOverLimit(text);
      if (over !== null) {
        throw new DeviceFrameTooLargeError({
          path: this.#options.path,
          bytes: over,
          limit: DEVICE_FRAME_MAX_BYTES,
        });
      }
      held.ws.send(text);
    } catch (error) {
      reportError(error, { source: 'realtime', scope: { operation: 'device.on_frame' } });
      // The code only: the device is a client, and a cause is this node's to read in its log.
      this.#send(held.ws, {
        type: 'error',
        code: isUltimateError(error) ? error.code : 'X_INTERNAL',
      });
    }
  }

  /** `reconnect` is the sync protocol's own frame, built by its one builder. */
  #send(ws: DeviceWs, frame: DeviceOutbound | ReturnType<typeof reconnectFrame>): boolean {
    return ws.send(JSON.stringify(frame)) !== 0;
  }

  #offline(to: string, id: string, reason: string): void {
    this.#background(this.#options.bus.reply(to, { kind: 'offline', id, reason }), 'device.reply');
  }

  #registrationTtl(): number {
    return this.#options.heartbeatMs * REGISTRATION_BEATS;
  }

  /** A bus write nobody awaits: its failure is reported, never left unhandled. */
  #background(work: Promise<void>, operation: string): void {
    work.catch((error: unknown) => {
      reportError(error, { source: 'realtime', scope: { operation } });
    });
  }
}
