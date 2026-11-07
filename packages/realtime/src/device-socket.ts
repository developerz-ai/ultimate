// `deviceSocket()`: a declared, long-lived socket for a client that is not a browser — a device
// agent that dials out and receives work. A factory over `route`: the value IS a websocket mount
// (`path`, `fetch`, `websocket`, the shape `@ultimat3/http`'s `WebSocketMount` reads), plus
// `request()`, which reaches one connected device from any process the framework booted.

import type { Actor, Clock } from '@ultimat3/core';
import { ConfigInvalidError, finiteOption, onShutdown, systemClock } from '@ultimat3/core';
import { DeviceBus } from './device-bus';
import { declarerFile } from './device-declarer';
import {
  DEVICE_MAX_DEADLINE_MS,
  DeviceFrameTooLargeError,
  DeviceOfflineError,
} from './device-errors';
import { type DeviceFrameHandler, DeviceHost, type DeviceWs } from './device-host';
import {
  answerDeviceUpgrade,
  type DeviceTokenResolver,
  type DeviceUpgradeTarget,
  tenantOf,
} from './device-upgrade';
import { bytesOverLimit, DEVICE_FRAME_MAX_BYTES } from './device-wire';
import type { Transport } from './fanout';
import type { JsonValue } from './json';
import { PrincipalSockets } from './principal-sockets';
import { AcceptBudget, type Rng, type Scheduler, timeoutScheduler } from './thundering-herd';

export const DEFAULT_DEVICE_HEARTBEAT_MS = 15_000;
export const DEFAULT_DEVICE_SOCKETS_PER_ACTOR = 10;
export const DEFAULT_DEVICE_REQUEST_DEADLINE_MS = 30_000;
/** How long `resolveToken` may hold an upgrade before it is answered 503. */
export const DEVICE_AUTH_DEADLINE_MS = 5_000;
/** Upgrades parked in `resolveToken` at once, per declaration per node; past it, shed. */
export const DEVICE_MAX_PENDING_UPGRADES = 256;
const MIN_HEARTBEAT_MS = 1_000;
const MAX_HEARTBEAT_MS = 300_000;
/** Accepts per second during a reconnect herd, and the burst before that bites. */
const ACCEPT_PER_SECOND = 100;
/** The drain's defaults: the sync node's, so a fleet restart spreads devices as it spreads tabs. */
const DRAIN_GRACE_MS = 5_000;
const DRAIN_SPREAD_MS = 30_000;

export interface DeviceSocketOptions {
  /** `'/link'` — lowercase segments, never under `/_x` or `/api`, which the framework serves. */
  readonly path: string;
  readonly resolveToken: DeviceTokenResolver;
  readonly onFrame: DeviceFrameHandler;
  readonly maxSocketsPerActor?: number | undefined;
  /** How often a device must send a frame (a `{ type: 'beat' }` is free); silent for two, it is closed. */
  readonly heartbeatMs?: number | undefined;
  /** Browser origins admitted, exactly. Empty (the default): an upgrade with an `Origin` is refused. */
  readonly allowedOrigins?: readonly string[] | undefined;
}

/** What a process hands a declaration so it can reach devices, and hold them when it serves. */
export interface DeviceAttachOptions {
  readonly transport: Transport;
  readonly clock?: Clock | undefined;
  readonly rng?: Rng | undefined;
  readonly schedule?: Scheduler | undefined;
  /** This process accepts device sockets (the web role); `false` only addresses them. */
  readonly serve: boolean;
  /** Register the drain on core's lifecycle. `false` for a host that drains by hand (a test). */
  readonly lifecycle?: boolean | undefined;
}

export interface DeviceAttachment {
  drain(options?: { graceMs?: number; spreadMs?: number }): Promise<void>;
  stop(): void;
}

export interface DeviceRequestOptions {
  readonly deadlineMs?: number | undefined;
}

export interface DeviceSocket {
  readonly path: string;
  fetch(request: Request, server: DeviceUpgradeTarget): Promise<Response | undefined>;
  readonly websocket: {
    open(ws: DeviceWs): void;
    message(ws: DeviceWs, message: string | Uint8Array): void;
    close(ws: DeviceWs): void;
    readonly maxPayloadLength: number;
    readonly idleTimeout: number;
  };
  /**
   * One frame to one device, its answer back — from an action, a job, any role. Scoped to the
   * caller's tenant (`ctx.actor.orgId`): a device registered under another one is `X_DEVICE_OFFLINE`,
   * exactly as an unknown one is.
   */
  request(
    ctx: { readonly actor: Actor },
    deviceId: string,
    frame: JsonValue,
    options?: DeviceRequestOptions,
  ): Promise<JsonValue>;
  attach(options: DeviceAttachOptions): Promise<DeviceAttachment>;
  /** Sockets this process holds for this declaration. */
  readonly connected: number;
}

/** Each path's declaration, the generation of the scan that evaluated it, and its module's file. */
const declared = new Map<
  string,
  { readonly link: DeviceSocket; readonly generation: number; readonly by: string | null }
>();
/**
 * Bumped by `x dev` before each rescan, never by a container (one scan per process). A module the
 * rescan re-evaluates declares its path again: in a NEW generation that is the same declaration,
 * edited, and replaces the old value; inside one generation it is a second module claiming the
 * path, and so is a DIFFERENT module in any generation — the holder was not re-evaluated, only
 * evicted modules are (`app-reload-graph.ts`), so taking its path would silently swap its handler.
 */
let generation = 0;

/** Every declaration this process imported, in declaration order — what a boot attaches. */
export function declaredDeviceSockets(): readonly DeviceSocket[] {
  return [...declared.values()].map((entry) => entry.link);
}

/** `x dev`'s rescan seam: a path declared from here on replaces its earlier generation's value. */
export function beginDeviceSocketGeneration(): void {
  generation += 1;
}

/** Test seam: forget every declaration, the state a process boots in — `resetChannelTransport`'s twin. */
export function forgetDeviceSockets(): void {
  declared.clear();
}

const PATH = /^\/[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;

function invalid(path: string, cause: string, fix: string): ConfigInvalidError {
  return new ConfigInvalidError({
    cause: `deviceSocket("${path}"): ${cause}`,
    fix,
    meta: { path },
  });
}

function screenPath(path: string, by: string | null): string {
  const shown = PATH.test(path) ? path : '<invalid>';
  if (!PATH.test(path)) {
    throw invalid(
      shown,
      'the path must be lowercase segments with no parameter or trailing slash',
      "deviceSocket({ path: '/link', … })",
    );
  }
  if (path === '/_x' || path.startsWith('/_x/') || path === '/api' || path.startsWith('/api/')) {
    throw invalid(
      path,
      'the framework serves /_x and /api itself',
      "deviceSocket({ path: '/link', … })",
    );
  }
  const held = declared.get(path);
  const elsewhere = held?.by != null && by !== null && held.by !== by;
  if (held?.generation === generation || elsewhere) {
    throw invalid(
      path,
      elsewhere
        ? `${held.by} already declares this path, and ${by} declares it again`
        : 'another deviceSocket already declares this path',
      `grep -rn "path: '${path}'" apps/   # then keep one declaration; moved it? x stop && x dev`,
    );
  }
  return path;
}

function screenHeartbeat(value: number | undefined): number {
  const ms = finiteOption('deviceSocket', 'heartbeatMs', value ?? DEFAULT_DEVICE_HEARTBEAT_MS);
  if (ms >= MIN_HEARTBEAT_MS && ms <= MAX_HEARTBEAT_MS) return ms;
  throw invalid(
    '',
    `heartbeatMs must be between ${MIN_HEARTBEAT_MS} and ${MAX_HEARTBEAT_MS}, not ${ms}`,
    `deviceSocket({ heartbeatMs: ${DEFAULT_DEVICE_HEARTBEAT_MS}, … })`,
  );
}

function screenOrigins(origins: readonly string[] | undefined): readonly string[] {
  return Object.freeze(
    (origins ?? []).map((origin) => {
      const parsed = URL.parse(origin)?.origin;
      if (parsed === undefined || parsed === 'null') {
        throw invalid(
          '',
          `allowedOrigins holds ${JSON.stringify(origin)}, which is no origin`,
          "deviceSocket({ allowedOrigins: ['https://www.example.com'], … })",
        );
      }
      return parsed;
    }),
  );
}

function screenDeadline(value: number | undefined): number {
  const ms = finiteOption(
    'deviceLink.request',
    'deadlineMs',
    value ?? DEFAULT_DEVICE_REQUEST_DEADLINE_MS,
  );
  if (ms > 0 && ms <= DEVICE_MAX_DEADLINE_MS) return ms;
  throw invalid(
    '',
    `deadlineMs must be above 0 and at most ${DEVICE_MAX_DEADLINE_MS}, not ${ms}`,
    `deviceLink.request(ctx, deviceId, frame, { deadlineMs: ${DEFAULT_DEVICE_REQUEST_DEADLINE_MS} })`,
  );
}

const newId = (): string => crypto.randomUUID().replaceAll('-', '');

export function deviceSocket(options: DeviceSocketOptions): DeviceSocket {
  const by = declarerFile([import.meta.path]);
  const path = screenPath(options.path, by);
  const heartbeatMs = screenHeartbeat(options.heartbeatMs);
  const allowedOrigins = screenOrigins(options.allowedOrigins);
  // `PrincipalSockets` refuses a count below 1 or a fraction; the NaN screen is this one.
  const principals = new PrincipalSockets(
    finiteOption(
      'deviceSocket',
      'maxSocketsPerActor',
      options.maxSocketsPerActor ?? DEFAULT_DEVICE_SOCKETS_PER_ACTOR,
    ),
  );
  const parked = { count: 0 };
  let bus: DeviceBus | null = null;
  let host: DeviceHost | null = null;
  let accepting = false;
  let accept = new AcceptBudget({ perSecond: ACCEPT_PER_SECOND, burst: ACCEPT_PER_SECOND * 2 });
  let rng: Rng = Math.random;
  let clock: Clock = systemClock;
  let schedule: Scheduler = timeoutScheduler;

  const link: DeviceSocket = {
    path,
    fetch: (request, server) =>
      answerDeviceUpgrade(
        {
          path,
          allowedOrigins,
          resolveToken: options.resolveToken,
          accept,
          principals,
          rng,
          clock,
          schedule,
          authDeadlineMs: DEVICE_AUTH_DEADLINE_MS,
          maxPendingUpgrades: DEVICE_MAX_PENDING_UPGRADES,
          accepting: () => accepting && host !== null,
          newSocketId: newId,
          parked,
        },
        request,
        server,
      ),
    websocket: {
      open: (ws) => {
        if (host === null) ws.close(1013, 'not serving');
        else host.open(ws);
      },
      message: (ws, message) => host?.message(ws, message),
      close: (ws) => {
        if (host === null) principals.release(ws.data.socketId);
        else host.close(ws);
      },
      maxPayloadLength: DEVICE_FRAME_MAX_BYTES,
      // Bun's own idle cut sits past the beat sweep's, so the sweep (which says why) decides first.
      idleTimeout: Math.ceil((heartbeatMs * 3) / 1_000),
    },
    async request(ctx, deviceId, frame, requestOptions = {}) {
      const deadlineMs = screenDeadline(requestOptions.deadlineMs);
      const over = bytesOverLimit(JSON.stringify({ type: 'request', id: newId(), frame }));
      if (over !== null) {
        throw new DeviceFrameTooLargeError({ path, bytes: over, limit: DEVICE_FRAME_MAX_BYTES });
      }
      if (bus === null) {
        throw new DeviceOfflineError({
          path,
          deviceId,
          reason:
            'this process never attached the declaration to a bus (the boot attaches every declared deviceSocket)',
        });
      }
      return await bus.request(tenantOf(ctx.actor), deviceId, frame, deadlineMs);
    },
    async attach(attachOptions) {
      if (bus !== null) {
        throw invalid(
          path,
          'it is already attached in this process',
          'x doctor --json   # one boot attaches each declaration once',
        );
      }
      clock = attachOptions.clock ?? systemClock;
      rng = attachOptions.rng ?? Math.random;
      schedule = attachOptions.schedule ?? timeoutScheduler;
      accept = new AcceptBudget({
        perSecond: ACCEPT_PER_SECOND,
        burst: ACCEPT_PER_SECOND * 2,
        clock,
      });
      const nodeId = newId();
      const ownBus = new DeviceBus({
        transport: attachOptions.transport,
        path,
        nodeId,
        schedule,
        clock,
        newId,
      });
      const ownHost = attachOptions.serve
        ? new DeviceHost({
            path,
            heartbeatMs,
            onFrame: options.onFrame,
            bus: ownBus,
            principals,
            clock,
            rng,
            schedule,
          })
        : null;
      await ownBus.start(ownHost);
      bus = ownBus;
      host = ownHost;
      accepting = ownHost !== null;
      let cancelSweep: () => void = () => undefined;
      const arm = (): void => {
        cancelSweep = schedule(() => {
          ownHost?.sweep();
          arm();
        }, heartbeatMs);
      };
      if (ownHost !== null) arm();
      const drain = async (
        drainOptions: { graceMs?: number; spreadMs?: number } = {},
      ): Promise<void> => {
        accepting = false;
        await ownHost?.drain({
          graceMs: finiteOption(
            'deviceLink.drain',
            'graceMs',
            drainOptions.graceMs ?? DRAIN_GRACE_MS,
          ),
          spreadMs: finiteOption(
            'deviceLink.drain',
            'spreadMs',
            drainOptions.spreadMs ?? DRAIN_SPREAD_MS,
          ),
        });
      };
      // The sync node's two phases: stop taking sockets, then hand the held ones to the fleet.
      const hooks =
        attachOptions.lifecycle === false || ownHost === null
          ? []
          : [
              onShutdown(
                `realtime:device:${path}:accept`,
                () => {
                  accepting = false;
                },
                { phase: 'accept' },
              ),
              onShutdown(`realtime:device:${path}:drain`, () => drain(), { phase: 'inflight' }),
            ];
      return {
        drain,
        stop: () => {
          for (const unregister of hooks) unregister();
          cancelSweep();
          accepting = false;
          ownBus.stop();
          bus = null;
          host = null;
        },
      };
    },
    get connected() {
      return host?.count ?? 0;
    },
  };
  // `set` on a key it holds keeps its place: a reload re-declares a path, never reorders it.
  declared.set(path, { link, generation, by });
  return link;
}
