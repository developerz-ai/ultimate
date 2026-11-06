// Single responsibility: RFC 8628 — a CLI on a headless box gets a short user code to type into
// the app's own verification page while it polls. Both codes are stored hashed; the user code is
// 8 characters from a no-lookalike alphabet, and every guess at one is counted per caller key.
// Polling faster than `interval` is `slow_down`; a decision is final and spent exactly once.

import type { ResolvedAuthServerConfig } from './authorization-server-config';
import { consentInvalid } from './authorization-server-errors';
import { screenResource, screenScopes } from './authorization-server-request';
import {
  firstRefresh,
  refused,
  type TokenOutcome,
  tokenAnswer,
} from './authorization-server-tokens';
import type { AuthServerClient } from './authorization-server-types';
import { DEVICE_GRANT } from './authorization-server-types';
import { randomBytes, randomToken, sha256Hex } from './tokens';

/** RFC 8628 §6.1's consonant alphabet: no vowels (no words), no 0/O, 1/I/L lookalikes. */
export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const USER_CODE_LENGTH = 8;
export const DEVICE_INTERVAL_SECONDS = 5;

/** Rejection sampling: `byte % 20` over all 256 values would bias the first 16 letters. */
export function userCode(): string {
  let code = '';
  while (code.length < USER_CODE_LENGTH) {
    for (const byte of randomBytes(16)) {
      if (byte >= 240 || code.length === USER_CODE_LENGTH) continue;
      code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
    }
  }
  return code;
}

/** What a person types: any case, the dash optional, spaces ignored. */
export const normaliseUserCode = (typed: string): string =>
  typed.toUpperCase().replaceAll(/[\s-]/g, '');

export async function startDevice(
  config: ResolvedAuthServerConfig,
  form: ReadonlyMap<string, string>,
  client: AuthServerClient,
): Promise<TokenOutcome> {
  if (!client.grantTypes.includes(DEVICE_GRANT)) {
    return refused('unauthorized_client', 'this client may not use the device grant');
  }
  const scopes = screenScopes(config, client, form.get('scope'));
  if (scopes === null || scopes.length === 0) {
    return refused('invalid_scope', 'a requested scope is not one this client may be granted');
  }
  const resource = screenResource(config, form.get('resource'));
  if (resource === false) {
    return refused('invalid_target', 'the resource is not one this server issues tokens for');
  }
  const deviceCode = randomToken(32);
  const user = userCode();
  const now = config.clock.now();
  await config.store.putDevice({
    deviceCodeHash: sha256Hex(deviceCode),
    userCodeHash: sha256Hex(user),
    clientId: client.clientId,
    scopes,
    resource,
    status: 'pending',
    subject: null,
    grantedScopes: null,
    intervalSeconds: DEVICE_INTERVAL_SECONDS,
    lastPolledAt: null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + config.deviceSeconds * 1000),
  });
  const page = `${config.origin}${config.devicePath ?? ''}`;
  const shown = `${user.slice(0, 4)}-${user.slice(4)}`;
  return {
    ok: true,
    body: {
      device_code: deviceCode,
      user_code: shown,
      verification_uri: page,
      verification_uri_complete: `${page}?user_code=${shown}`,
      expires_in: config.deviceSeconds,
      interval: DEVICE_INTERVAL_SECONDS,
    },
  };
}

export type DeviceReading =
  | {
      readonly ok: true;
      readonly clientId: string;
      readonly scopes: readonly string[];
      readonly resource: string | null;
    }
  | { readonly ok: false; readonly reason: 'unknown' | 'expired' | 'decided' };

/**
 * The verification page's read. `key` is the caller's bucket (address or session): a miss counts
 * against it, so walking the code space locks the walker out (`X_ACCOUNT_LOCKED`) long before the
 * 20^8 codes give way. A hit gives its reservation back.
 */
export async function readDevice(
  config: ResolvedAuthServerConfig,
  typed: string,
  key: string,
): Promise<DeviceReading> {
  const reservation = await config.limiter.reserve(`oauth-device:${key}`);
  const device = await config.store.deviceByUserCode(sha256Hex(normaliseUserCode(typed)));
  if (device === null) return { ok: false, reason: 'unknown' };
  await config.limiter.refund(reservation);
  if (device.expiresAt.getTime() <= config.clock.now().getTime()) {
    return { ok: false, reason: 'expired' };
  }
  if (device.status !== 'pending') return { ok: false, reason: 'decided' };
  return { ok: true, clientId: device.clientId, scopes: device.scopes, resource: device.resource };
}

export async function decideDevice(
  config: ResolvedAuthServerConfig,
  input: {
    readonly userCode: string;
    readonly key: string;
    readonly approve: { readonly subject: string; readonly scopes: readonly string[] } | null;
  },
): Promise<void> {
  const reading = await readDevice(config, input.userCode, input.key);
  if (!reading.ok) throw consentInvalid(`the user code is ${reading.reason}`);
  const approved = input.approve?.scopes;
  if (
    approved !== undefined &&
    (approved.length === 0 || !approved.every((s) => reading.scopes.includes(s)))
  ) {
    throw consentInvalid(
      'the approved scopes are empty or not a subset of what the device asked for',
    );
  }
  const decided = await config.store.decideDevice(
    sha256Hex(normaliseUserCode(input.userCode)),
    input.approve === null
      ? { status: 'denied' }
      : { status: 'approved', subject: input.approve.subject, scopes: input.approve.scopes },
    config.clock.now(),
  );
  if (decided === null) throw consentInvalid('the user code was decided or expired meanwhile');
}

/** The device's poll on `POST /oauth/token`. */
export async function pollDevice(
  config: ResolvedAuthServerConfig,
  form: ReadonlyMap<string, string>,
  client: AuthServerClient,
): Promise<TokenOutcome> {
  const deviceCode = form.get('device_code');
  if (deviceCode === undefined) return refused('invalid_request', 'device_code is required');
  const now = config.clock.now();
  const hash = sha256Hex(deviceCode);
  const device = await config.store.pollDevice(hash, now);
  if (device === null || device.clientId !== client.clientId) {
    return refused('invalid_grant', 'the device code is unknown');
  }
  if (device.expiresAt.getTime() <= now.getTime()) {
    return refused('expired_token', 'the device code expired; start again');
  }
  const last = device.lastPolledAt;
  if (last !== null && now.getTime() - last.getTime() < device.intervalSeconds * 1000) {
    return refused('slow_down', `poll no faster than every ${device.intervalSeconds} seconds`);
  }
  if (device.status === 'pending') return refused('authorization_pending', 'not decided yet');
  if (device.status === 'denied') return refused('access_denied', 'the person declined');
  if (device.status === 'consumed' || device.subject === null) {
    return refused('invalid_grant', 'the device code was already used');
  }
  if (!(await config.store.consumeDevice(hash, now))) {
    return refused('invalid_grant', 'the device code was already used');
  }
  const grant = {
    id: `g_${randomToken(16)}`,
    clientId: client.clientId,
    subject: device.subject,
    scopes: device.grantedScopes ?? [],
    resource: device.resource,
    createdAt: now,
    refreshedAt: now,
    revokedAt: null,
  };
  await config.store.putGrant(grant);
  return tokenAnswer(config, grant, config.accessSeconds, await firstRefresh(config, grant.id));
}
