// The device socket's wire, both hops: the frames a device and its node exchange, and the envelopes
// nodes exchange over the bus to address one device from anywhere. JSON text only, and a size
// limit the framework owns — the one number no declaration can widen.

import { isJsonObject } from '@ultimat3/core';
import type { JsonValue } from './json';
import type { ReconnectFrame } from './sync-protocol';

/**
 * The largest frame either side may send, in UTF-8 bytes: 256 KiB. Bun's `maxPayloadLength` on the
 * mount enforces it before a byte is buffered, and `decodeDeviceFrame` again for a host that did
 * not apply it. Work that is bigger is a key into storage, not a frame.
 */
export const DEVICE_FRAME_MAX_BYTES = 256 * 1024;

/** What a device sends: a beat, a frame for `onFrame`, or the answer to a `request` by its id. */
export type DeviceInbound =
  | { readonly type: 'beat' }
  | { readonly type: 'frame'; readonly frame: JsonValue }
  | { readonly type: 'response'; readonly id: string; readonly frame: JsonValue };

/** What a node sends a device. `reconnect` is the sync protocol's own frame, unchanged. */
export type DeviceOutbound =
  | { readonly type: 'hello'; readonly heartbeatMs: number; readonly maxFrameBytes: number }
  | { readonly type: 'request'; readonly id: string; readonly frame: JsonValue }
  | { readonly type: 'frame'; readonly frame: JsonValue }
  | { readonly type: 'error'; readonly code: string }
  | ReconnectFrame;

const encoder = new TextEncoder();

/**
 * The frame's UTF-8 length when it is past the limit, else `null`. A UTF-16 unit is 1-3 UTF-8
 * bytes, so a string short enough cannot be over it and is never encoded just to be measured.
 */
export function bytesOverLimit(text: string): number | null {
  if (text.length * 3 <= DEVICE_FRAME_MAX_BYTES) return null;
  const bytes = encoder.encode(text).length;
  return bytes > DEVICE_FRAME_MAX_BYTES ? bytes : null;
}

/** `JSON.parse` that answers `undefined` instead of throwing — the input is a device's bytes. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A request/response id: what this node minted, so short and token-safe, never a device's prose. */
const isId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);

/** A device frame, or `undefined` for anything this protocol does not speak. */
export function decodeDeviceFrame(text: string): DeviceInbound | undefined {
  const raw = parseJson(text);
  if (!isJsonObject(raw)) return undefined;
  if (raw['type'] === 'beat') return { type: 'beat' };
  if (!Object.hasOwn(raw, 'frame')) return undefined;
  const frame = raw['frame'] as JsonValue;
  if (raw['type'] === 'frame') return { type: 'frame', frame };
  if (raw['type'] === 'response' && isId(raw['id']))
    return { type: 'response', id: raw['id'], frame };
  return undefined;
}

/** A node's frame to a device, or `undefined` — the device agent's half of the same whitelist. */
export function decodeNodeFrame(text: string): DeviceOutbound | undefined {
  const raw = parseJson(text);
  if (!isJsonObject(raw)) return undefined;
  switch (raw['type']) {
    case 'hello': {
      const { heartbeatMs, maxFrameBytes } = raw;
      if (typeof heartbeatMs !== 'number' || typeof maxFrameBytes !== 'number') return undefined;
      return { type: 'hello', heartbeatMs, maxFrameBytes };
    }
    case 'request':
      return isId(raw['id']) && Object.hasOwn(raw, 'frame')
        ? { type: 'request', id: raw['id'], frame: raw['frame'] as JsonValue }
        : undefined;
    case 'frame':
      return Object.hasOwn(raw, 'frame')
        ? { type: 'frame', frame: raw['frame'] as JsonValue }
        : undefined;
    case 'error':
      return typeof raw['code'] === 'string' ? { type: 'error', code: raw['code'] } : undefined;
    case 'reconnect': {
      const { afterMs, reason, v } = raw;
      if (typeof afterMs !== 'number' || typeof v !== 'number') return undefined;
      if (reason !== 'drain' && reason !== 'overload' && reason !== 'rebalance') return undefined;
      return { type: 'reconnect', v, afterMs, reason };
    }
    default:
      return undefined;
  }
}

/** A request on its way to the node that holds the device. */
export interface BusRequest {
  readonly kind: 'request';
  readonly id: string;
  /** The requesting node: its reply subject is derived from this, never taken as a subject. */
  readonly from: string;
  readonly tenant: string;
  readonly deviceId: string;
  /** How long the requester waits — the holder forgets the request after it, answered or not. */
  readonly deadlineMs: number;
  readonly frame: JsonValue;
}

/** The holder's answer: the device's frame, or "it is not here". */
export type BusReply =
  | { readonly kind: 'response'; readonly id: string; readonly frame: JsonValue }
  | { readonly kind: 'offline'; readonly id: string; readonly reason: string };

/** A newer socket for one device opened somewhere: every other holder closes its own. */
export interface BusClaim {
  readonly kind: 'claim';
  readonly tenant: string;
  readonly deviceId: string;
  readonly node: string;
  readonly socketId: string;
}

export type BusMessage = BusRequest | BusReply | BusClaim;

const isText = (value: unknown): value is string => typeof value === 'string';

/** A bus payload, rebuilt field by field — another node's bytes are still bytes. */
export function decodeBusMessage(text: string): BusMessage | undefined {
  const raw = parseJson(text);
  if (!isJsonObject(raw)) return undefined;
  const { kind, id, tenant, deviceId } = raw;
  if (kind === 'request') {
    const { from, deadlineMs } = raw;
    if (!isId(id) || !isId(from) || !isText(tenant) || !isText(deviceId)) return undefined;
    if (typeof deadlineMs !== 'number' || !(deadlineMs > 0) || !Object.hasOwn(raw, 'frame')) {
      return undefined;
    }
    return { kind, id, from, tenant, deviceId, deadlineMs, frame: raw['frame'] as JsonValue };
  }
  if (kind === 'response' && isId(id) && Object.hasOwn(raw, 'frame')) {
    return { kind, id, frame: raw['frame'] as JsonValue };
  }
  if (kind === 'offline' && isId(id) && isText(raw['reason'])) {
    return { kind, id, reason: raw['reason'] };
  }
  if (kind === 'claim') {
    const { node, socketId } = raw;
    if (!isText(tenant) || !isText(deviceId) || !isId(node) || !isText(socketId)) return undefined;
    return { kind, tenant, deviceId, node, socketId };
  }
  return undefined;
}
