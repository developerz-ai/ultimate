// Single responsibility: one push to one Android device over FCM HTTP v1 — a service-account
// assertion (RS256) exchanged for an OAuth access token, cached until shortly before it expires,
// then the send, each under a deadline, and the answer read as delivered, gone or refused.

import { ConfigInvalidError } from '@ultimat3/core';
import { outbound } from '@ultimat3/core/outbound';
import { t } from '@ultimat3/schema';
import { signJwt } from './native-jwt';
import type { NativeTransportDeps, ProviderRefusal } from './native-transport';
import { refusalOf, signingKeyFrom } from './native-transport';
import {
  NotifyPushDeviceGoneError,
  NotifyPushProviderRefusedError,
  providerReason,
} from './push-errors';
import type { NativePush, NativeSender } from './push-message';
import type { TokenCache } from './token-cache';
import { tokenCache } from './token-cache';

export interface FcmOptions {
  /** The Firebase project id — the `project_id` of the service-account JSON. */
  readonly projectId: string;
  /** The service account's `client_email`. Its `private_key` is `ULTIMATE_FCM_PRIVATE_KEY`. */
  readonly clientEmail: string;
}

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const FCM_ORIGIN = 'https://fcm.googleapis.com';
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** The assertion's own life (Google's maximum), and how early a cached access token is replaced. */
const ASSERTION_SECONDS = 3_600;
export const FCM_TOKEN_REFRESH_BEFORE_MS = 5 * 60_000;

const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const CLIENT_EMAIL = /^[A-Za-z0-9._-]{1,128}@[a-z0-9.-]{1,128}$/;

const AccessToken = t.object({ access_token: t.string.min(1), expires_in: t.number.int() });

function screen(options: FcmOptions): void {
  for (const [field, value, rule] of [
    ['projectId', options.projectId, PROJECT],
    ['clientEmail', options.clientEmail, CLIENT_EMAIL],
  ] as const) {
    if (!rule.test(value)) {
      throw new ConfigInvalidError({
        cause: `nativePush({ fcm }) ${field} is not what a Firebase service account carries`,
        fix: `nativePush({ fcm: { projectId, clientEmail } })   # copy project_id and client_email from the service-account JSON`,
        meta: { field },
      });
    }
  }
}

/** The `message` the wire carries, built from `push` and nothing else. */
export function fcmMessage(token: string, push: NativePush): Record<string, unknown> {
  if (push.kind === 'data') {
    // No `notification` block: Android hands the ids to the app and draws nothing.
    return { token, data: { ...push.data }, android: { priority: 'high' } };
  }
  const { push: alert } = push;
  return {
    token,
    notification: { title: alert.title, body: alert.body },
    data: { url: alert.url },
    android: {
      priority: alert.urgent ? 'high' : 'normal',
      ttl: `${String(alert.ttlSeconds)}s`,
      ...(alert.collapse === undefined ? {} : { collapse_key: alert.collapse }),
    },
  };
}

/**
 * FCM's dead-token answer: `UNREGISTERED` in the error's details. Never a bare 404 — a wrong
 * `projectId` is a 404 too, and reading it as "gone" would delete every Android device the app
 * has. The detail is cut at 200 characters, so a body too long to parse is searched as text.
 */
function isUnregistered(refusal: ProviderRefusal): boolean {
  const details = (refusal.body?.['error'] as { details?: unknown } | undefined)?.details;
  if (Array.isArray(details)) {
    return details.some(
      (entry: unknown) => (entry as { errorCode?: unknown } | null)?.errorCode === 'UNREGISTERED',
    );
  }
  return refusal.body === undefined && refusal.detail.includes('"UNREGISTERED"');
}

const reasonOf = (body: Readonly<Record<string, unknown>> | undefined): string => {
  const error = body?.['error'];
  // The send API nests `{ error: { status } }`; the token endpoint answers `{ error: 'invalid_grant' }`.
  return providerReason(
    typeof error === 'string' ? error : (error as { status?: unknown })?.status,
  );
};

/** The sentence FCM answers an unparseable token with — inside the first 200 characters. */
const BAD_TOKEN_TEXT = 'not a valid FCM registration token';

/**
 * `INVALID_ARGUMENT` is a bad payload as often as a bad token, so only the `BadRequest` violation
 * on `message.token` (or, in a detail cut too short to parse, FCM's own sentence for it) counts
 * against the row: a payload bug must never delete every Android device the app has.
 */
function isBadToken(refusal: ProviderRefusal): boolean {
  if (refusal.status !== 400) return false;
  const details = (refusal.body?.['error'] as { details?: unknown } | undefined)?.details;
  if (!Array.isArray(details)) {
    return refusal.body === undefined && refusal.detail.includes(BAD_TOKEN_TEXT);
  }
  return details.some((entry: unknown) => {
    const violations = (entry as { fieldViolations?: unknown } | null)?.fieldViolations;
    return (
      Array.isArray(violations) &&
      violations.some(
        (violation: unknown) =>
          (violation as { field?: unknown } | null)?.field === 'message.token',
      )
    );
  });
}

const refused = (
  status: number,
  reason: string,
  flags: { credential?: boolean; badToken?: boolean } = {},
) => new NotifyPushProviderRefusedError({ provider: 'fcm', status, reason, ...flags });

export function fcmSender(options: FcmOptions, deps: NativeTransportDeps): NativeSender {
  screen(options);
  const wallMs = (): number => deps.clock.now().getTime();
  const now = (): number => deps.clock.monotonic();
  const access: TokenCache = tokenCache(
    async () => {
      const issuedAt = Math.floor(wallMs() / 1000);
      const key = await signingKeyFrom(deps.env, 'fcm');
      const assertion = await signJwt(
        'RS256',
        key,
        { typ: 'JWT' },
        {
          iss: options.clientEmail,
          scope: FCM_SCOPE,
          aud: GOOGLE_TOKEN_URL,
          iat: issuedAt,
          exp: issuedAt + ASSERTION_SECONDS,
        },
      );
      try {
        const answer = await outbound(
          {
            url: GOOGLE_TOKEN_URL,
            vendor: 'google-oauth',
            dial: 'named',
            deadlineMs: deps.deadlineMs,
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
              assertion,
            }).toString(),
          },
          { fetch: deps.fetch, now },
        );
        const token = answer.json(AccessToken);
        return { value: token.access_token, expiresAt: wallMs() + token.expires_in * 1000 };
      } catch (error) {
        const refusal = refusalOf(error);
        if (refusal === undefined) throw error;
        // Whatever the status, Google refusing the assertion is the service account's key.
        throw refused(refusal.status, reasonOf(refusal.body), { credential: true });
      }
    },
    wallMs,
    FCM_TOKEN_REFRESH_BEFORE_MS,
  );
  const url = `${FCM_ORIGIN}/v1/projects/${options.projectId}/messages:send`;
  return {
    async send(token, push, signal) {
      const body = JSON.stringify({ message: fcmMessage(token, push) });
      const bearer = await access.get();
      try {
        await outbound(
          {
            url,
            vendor: 'fcm',
            dial: 'named',
            deadlineMs: deps.deadlineMs,
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
            body,
            signal,
          },
          { fetch: deps.fetch, now },
        );
      } catch (error) {
        const refusal = refusalOf(error);
        if (refusal === undefined) throw error;
        if (isUnregistered(refusal)) {
          throw new NotifyPushDeviceGoneError({
            provider: 'fcm',
            status: refusal.status,
            reason: 'UNREGISTERED',
          });
        }
        if (refusal.status === 401 || refusal.status === 403) access.invalidate(bearer);
        throw refused(refusal.status, reasonOf(refusal.body), { badToken: isBadToken(refusal) });
      }
    },
  };
}
