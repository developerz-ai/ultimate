/**
 * The device link: Postly's desktop agents dial `/link` with their enrolment token and stay
 * connected; the app sends them work with `deviceLink.request(ctx, deviceId, frame)` from any
 * action or job, and they report status frames back. One declaration — the framework owns the
 * upgrade auth, the per-actor cap, the beat, the frame limit, the drain and the addressing.
 */

import { deviceSocket } from '@ultimat3/realtime/server';
import { resolveDeviceToken } from './token';

export const deviceLink = deviceSocket({
  path: '/link',
  resolveToken: resolveDeviceToken,
  maxSocketsPerActor: 10,
  heartbeatMs: 15_000,
  // A status report is acknowledged with the device the socket authenticated as — never one the
  // frame names, which is the device's own claim.
  onFrame: ({ frame, device }) => ({ ack: device.deviceId, received: frame }),
});
