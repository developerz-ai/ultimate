// Single responsibility: one push to one iOS device over APNs — token auth (an ES256 JWT signed
// with the team's `.p8` key, cached and re-signed before Apple's hour runs out), HTTP/2, a deadline
// over the whole call, and the answer read as delivered, gone or refused.

import { ConfigInvalidError } from '@ultimat3/core';
import { outbound } from '@ultimat3/core/outbound';
import { signJwt } from './native-jwt';
import type { NativeTransportDeps } from './native-transport';
import { http2, refusalOf, signingKeyFrom } from './native-transport';
import {
  NotifyPushDeviceGoneError,
  NotifyPushProviderRefusedError,
  providerReason,
} from './push-errors';
import type { NativePush, NativeSender } from './push-message';
import type { TokenCache } from './token-cache';
import { tokenCache } from './token-cache';

export interface ApnsOptions {
  /** The 10-character Team ID the key belongs to. */
  readonly teamId: string;
  /** The 10-character Key ID of the `.p8` key in `ULTIMATE_APNS_PRIVATE_KEY`. */
  readonly keyId: string;
  /** The app's bundle id — `apns-topic`. */
  readonly topic: string;
  /** `sandbox` for a development build's tokens. Default `production`. */
  readonly environment?: 'production' | 'sandbox' | undefined;
}

export const APNS_ORIGINS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const;

/** Apple refuses a token older than an hour and throttles one re-signed inside 20 minutes. */
export const APNS_TOKEN_LIFETIME_MS = 60 * 60_000;
export const APNS_TOKEN_REFRESH_BEFORE_MS = 10 * 60_000;

const TEN = /^[A-Z0-9]{10}$/;
const TOPIC = /^[A-Za-z0-9.-]{1,155}$/;

function screen(options: ApnsOptions): void {
  for (const [field, value, rule] of [
    ['teamId', options.teamId, TEN],
    ['keyId', options.keyId, TEN],
    ['topic', options.topic, TOPIC],
  ] as const) {
    if (!rule.test(value)) {
      throw new ConfigInvalidError({
        cause: `nativePush({ apns }) ${field} is not what Apple issues (${String(rule)})`,
        fix: `nativePush({ apns: { teamId, keyId, topic } })   # copy ${field} from the Apple developer account's Keys page or the app's bundle id`,
        meta: { field },
      });
    }
  }
}

/** The wire: headers and body built from `push` and nothing else. */
export function apnsRequest(
  push: NativePush,
  topic: string,
  nowSeconds: number,
): { readonly headers: Record<string, string>; readonly body: string } {
  if (push.kind === 'data') {
    // Background: Apple requires priority 5 for it, and the app is woken with the ids alone.
    return {
      headers: { 'apns-topic': topic, 'apns-push-type': 'background', 'apns-priority': '5' },
      body: JSON.stringify({ ...push.data, aps: { 'content-available': 1 } }),
    };
  }
  const { push: alert } = push;
  const headers: Record<string, string> = {
    'apns-topic': topic,
    'apns-push-type': 'alert',
    'apns-priority': alert.urgent ? '10' : '5',
    'apns-expiration': String(nowSeconds + alert.ttlSeconds),
  };
  if (alert.collapse !== undefined) headers['apns-collapse-id'] = alert.collapse;
  return {
    headers,
    body: JSON.stringify({
      aps: { alert: { title: alert.title, body: alert.body } },
      url: alert.url,
    }),
  };
}

export function apnsSender(options: ApnsOptions, deps: NativeTransportDeps): NativeSender {
  screen(options);
  const origin = APNS_ORIGINS[options.environment ?? 'production'];
  const wallMs = (): number => deps.clock.now().getTime();
  const provider: TokenCache = tokenCache(
    async () => {
      const issuedAt = wallMs();
      const key = await signingKeyFrom(deps.env, 'apns');
      const value = await signJwt(
        'ES256',
        key,
        { kid: options.keyId },
        { iss: options.teamId, iat: Math.floor(issuedAt / 1000) },
      );
      return { value, expiresAt: issuedAt + APNS_TOKEN_LIFETIME_MS };
    },
    wallMs,
    APNS_TOKEN_REFRESH_BEFORE_MS,
  );
  return {
    async send(token, push, signal) {
      const request = apnsRequest(push, options.topic, Math.floor(wallMs() / 1000));
      const bearer = await provider.get();
      try {
        await outbound(
          {
            // The token was screened hex (`APNS_TOKEN`), so it cannot leave the path segment.
            url: `${origin}/3/device/${token}`,
            vendor: 'apns',
            dial: 'named',
            deadlineMs: deps.deadlineMs,
            method: 'POST',
            headers: { ...request.headers, authorization: `bearer ${bearer}` },
            body: request.body,
            signal,
          },
          { fetch: http2(deps.fetch), now: () => deps.clock.monotonic() },
        );
      } catch (error) {
        const refusal = refusalOf(error);
        if (refusal === undefined) throw error;
        const reason = providerReason(refusal.body?.['reason']);
        if (refusal.status === 410) {
          throw new NotifyPushDeviceGoneError({ provider: 'apns', status: 410, reason });
        }
        // Expired or revoked provider token: the next send signs a fresh one.
        if (refusal.status === 403) provider.invalidate(bearer);
        throw new NotifyPushProviderRefusedError({
          provider: 'apns',
          status: refusal.status,
          reason,
          // Also a sandbox token sent to production, so counted per row, never read as gone.
          badToken: refusal.status === 400 && reason === 'BadDeviceToken',
        });
      }
    },
  };
}
