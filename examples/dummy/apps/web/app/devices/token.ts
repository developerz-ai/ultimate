/**
 * A device's credential: sealed claims (org, owner, device, expiry) under the app's master key, so
 * nothing is stored and a forged or edited token fails the AEAD tag. Minted for an org's device by
 * whoever enrols it; resolved on the device socket's upgrade, before any frame.
 */

import type { Clock } from '@ultimat3/core';
import {
  isJsonObject,
  open,
  SealInvalidError,
  SealKeyUnknownError,
  seal,
  systemClock,
  userActor,
} from '@ultimat3/core';
import type { DeviceGrant } from '@ultimat3/realtime/server';

/** Bound into the tag: a token sealed for anything else does not open as a device's. */
const PURPOSE = 'device-link';

/** Thirty days: a device re-enrols monthly, and a lost one stops working on its own. */
export const DEVICE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface DeviceEnrolment {
  readonly orgId: string;
  readonly ownerId: string;
  readonly deviceId: string;
}

export async function mintDeviceToken(
  enrolment: DeviceEnrolment,
  options: { readonly clock?: Clock; readonly ttlMs?: number } = {},
): Promise<string> {
  const clock = options.clock ?? systemClock;
  const exp = clock.now().getTime() + (options.ttlMs ?? DEVICE_TOKEN_TTL_MS);
  const claims = { o: enrolment.orgId, u: enrolment.ownerId, d: enrolment.deviceId, e: exp };
  return seal(JSON.stringify(claims), { purpose: PURPOSE });
}

/**
 * The grant, or `null` for anything that is not a token this app sealed — malformed, forged, a
 * retired key. Expiry rides the grant as `expiresAt`: the socket refuses it at the upgrade and
 * closes it when it passes, so this never compares a clock itself.
 */
export async function resolveDeviceToken(token: string): Promise<DeviceGrant | null> {
  let text: string;
  try {
    text = new TextDecoder().decode(await open(token, { purpose: PURPOSE }));
  } catch (error) {
    if (error instanceof SealInvalidError || error instanceof SealKeyUnknownError) return null;
    throw error;
  }
  let claims: unknown;
  try {
    claims = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isJsonObject(claims)) return null;
  const { o, u, d, e } = claims;
  if (typeof o !== 'string' || typeof u !== 'string' || typeof d !== 'string') return null;
  if (typeof e !== 'number') return null;
  return { actor: userActor({ id: u, orgId: o }), deviceId: d, expiresAt: e };
}
