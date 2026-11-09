// Every refusal a `deviceSocket()` makes. The three device codes are its own; an upgrade refusal
// reuses the sync node's socket codes (the condition is the same one), with a fix that names the
// device declaration instead of `syncNode`, because that is the file the reader has to edit.

import { renderFixShellArg } from '@ultimat3/core';
import { RealtimeError } from './realtime-error';

/** The longest `deadlineMs` a request may wait — here, so the timeout's `fix:` never prints past it. */
export const DEVICE_MAX_DEADLINE_MS = 600_000;

/** The device's id rendered for a pasteable call: verbatim when shell-safe, a placeholder otherwise. */
const idArg = (deviceId: string): string => renderFixShellArg(deviceId, '<deviceId>');

/**
 * No socket is open for this device, for this tenant, on any node. Answered at once — never by
 * waiting out the deadline — and identically for a device of another tenant, so a request cannot
 * learn that a device id exists somewhere it may not reach.
 */
export class DeviceOfflineError extends RealtimeError {
  constructor(args: { path: string; deviceId: string; reason: string }) {
    super({
      code: 'X_DEVICE_OFFLINE',
      cause: `deviceSocket("${args.path}") holds no open socket for device ${JSON.stringify(args.deviceId)} under the caller's tenant: ${args.reason}`,
      fix: `x doctor --json   # then retry deviceLink.request(ctx, '${idArg(args.deviceId)}', frame) once the device redials; across replicas every role needs NATS_URL set (or one transport in apps/<app>/runtime.ts)`,
    });
  }
}

/** The device took the request frame and sent no `response` carrying its id before the deadline. */
export class DeviceRequestTimeoutError extends RealtimeError {
  constructor(args: { path: string; deviceId: string; deadlineMs: number }) {
    super({
      code: 'X_DEVICE_REQUEST_TIMEOUT',
      cause: `device ${JSON.stringify(args.deviceId)} on deviceSocket("${args.path}") did not answer within ${args.deadlineMs}ms`,
      fix: `deviceLink.request(ctx, '${idArg(args.deviceId)}', frame, { deadlineMs: ${Math.min(args.deadlineMs * 2, DEVICE_MAX_DEADLINE_MS)} })   # or answer every request with { type: 'response', id, frame } on the device`,
    });
  }
}

/** A frame past `DEVICE_FRAME_MAX_BYTES`, in either direction. */
export class DeviceFrameTooLargeError extends RealtimeError {
  constructor(args: { path: string; bytes: number; limit: number }) {
    super({
      code: 'X_DEVICE_FRAME_TOO_LARGE',
      cause: `a frame of ${args.bytes} bytes on deviceSocket("${args.path}") is past the framework's ${args.limit}-byte frame limit`,
      fix: `import { DEVICE_FRAME_MAX_BYTES } from '@ultimat3/realtime/server'   # then split the payload under it, or store the bytes and send their key`,
    });
  }
}

/** No bearer token, or one the resolver refused or that has expired: 401 before any socket exists. */
export function deviceUnauthenticated(path: string, reason: string): RealtimeError {
  return new RealtimeError({
    code: 'X_SOCKET_UNAUTHENTICATED',
    cause: `the device upgrade on ${path} was refused: ${reason}`,
    fix: `curl -i -H 'Authorization: Bearer <token>' -H 'Upgrade: websocket' "$APP_URL${renderFixShellArg(path, '/link')}"   # a token deviceSocket({ resolveToken }) resolves to a grant whose expiresAt is in the future`,
  });
}

/** The actor already holds `limit` device sockets on this node. */
export function deviceSocketLimit(path: string, limit: number): RealtimeError {
  return new RealtimeError({
    code: 'X_SOCKET_LIMIT',
    cause: `this actor already holds ${limit} sockets on deviceSocket("${path}") on this node — its maxSocketsPerActor`,
    fix: `deviceSocket({ path: '${path}', maxSocketsPerActor: ${limit * 2}, … })   # or close the actor's other device connections`,
  });
}

/**
 * The upgrade carried an `Origin`, so a BROWSER is dialling — and a device socket is for clients
 * that are not one. Only an origin the declaration lists exactly is admitted.
 */
export function deviceOriginRefused(path: string, admitted: readonly string[]): RealtimeError {
  const list = admitted.length === 0 ? 'no browser origin at all' : `only ${admitted.join(', ')}`;
  return new RealtimeError({
    code: 'X_SOCKET_ORIGIN_REFUSED',
    cause: `the device upgrade on ${path} carried an Origin header, and this device socket admits ${list}`,
    fix: `deviceSocket({ path: '${path}', allowedOrigins: ['https://www.example.com'], … })   # only when a browser page really is a device; a non-browser client sends no Origin`,
  });
}

/** The resolver raised, or did not decide within the upgrade's deadline: come back, not "signed out". */
export function deviceAuthUnavailable(detail: string): RealtimeError {
  return new RealtimeError({
    code: 'X_SOCKET_AUTH_UNAVAILABLE',
    cause: `deviceSocket({ resolveToken }) did not decide who a connecting device is: ${detail}`,
    fix: 'x doctor --json',
  });
}
