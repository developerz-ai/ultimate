// Single responsibility: what the APNs and FCM senders share — the injected seams, the private key
// read out of the environment (where `x secrets` puts it) straight into a `Secret` box, and a coded
// `outbound()` refusal read back into a status and the provider's reason.

import type { Clock } from '@ultimat3/core';
import { ConfigInvalidError, EnvMissingError, isUltimateError, secret } from '@ultimat3/core';
import type { OutboundFetch, OutboundInit } from '@ultimat3/core/outbound';
import { importSigningKey } from './native-jwt';
import type { PushProvider } from './push-errors';

export interface NativeTransportDeps {
  /** "Just the call" — the platform's `fetch` unless a test hands its fake provider. */
  readonly fetch: OutboundFetch;
  /** Where the private keys are read, per mint. `Bun.env` unless a test hands its own. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  /** The whole call to the provider, retries included. */
  readonly deadlineMs: number;
}

/** The platform's `fetch`, read per call so a test's sealed network sees it. */
export const platformFetch: OutboundFetch = (url, init) => fetch(url, init);

/**
 * APNs speaks HTTP/2 only; an HTTP/1.1 request is a malformed response. Bun's `fetch` negotiates it
 * when asked, so the transport asks on every APNs hop.
 */
export const http2 =
  (base: OutboundFetch): OutboundFetch =>
  (url, init) =>
    base(url, Object.assign({}, init, { protocol: 'http2' }) satisfies OutboundInit);

/** Where each provider's private key is read from — `x secrets set <name>` puts it there. */
export const APNS_KEY_ENV = 'ULTIMATE_APNS_PRIVATE_KEY';
export const FCM_KEY_ENV = 'ULTIMATE_FCM_PRIVATE_KEY';

/** Spelled per provider rather than interpolated: a `fix:` names its command whole. */
const SET_APNS_KEY =
  'x secrets set ULTIMATE_APNS_PRIVATE_KEY   # paste the .p8 file whole, BEGIN and END lines included; a real environment variable of that name wins';
const SET_FCM_KEY =
  'x secrets set ULTIMATE_FCM_PRIVATE_KEY   # paste the service-account private_key whole, BEGIN and END lines included; a real environment variable of that name wins';

/** The provider's signing key, imported — or the refusal naming its variable, never its value. */
export async function signingKeyFrom(
  env: NativeTransportDeps['env'],
  provider: PushProvider,
): Promise<CryptoKey> {
  const apns = provider === 'apns';
  const variable = apns ? APNS_KEY_ENV : FCM_KEY_ENV;
  const fix = apns ? SET_APNS_KEY : SET_FCM_KEY;
  const raw = env[variable];
  if (raw === undefined || raw.trim() === '') {
    throw new EnvMissingError({
      cause: `nativePush() needs ${variable} to sign its ${provider} token, and the environment has none`,
      fix,
      meta: { variable },
    });
  }
  const key = await importSigningKey(apns ? 'ES256' : 'RS256', secret(raw, variable));
  if (key === undefined) {
    throw new ConfigInvalidError({
      cause: `${variable} is not a PKCS#8 ${apns ? 'P-256 (.p8)' : 'RSA'} private key`,
      fix,
      meta: { variable },
    });
  }
  return key;
}

/** A provider's refusal as `outbound()` coded it: the status, and the JSON body it kept. */
export interface ProviderRefusal {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>> | undefined;
  /** The redacted text itself — read when a long body was cut and no longer parses. */
  readonly detail: string;
}

/**
 * `X_OUTBOUND_REFUSED`'s status and `meta.detail` (a redacted JSON object, 200 characters at most —
 * so a cut one parses to nothing and the status alone decides). Anything else is `undefined`: a
 * 5xx, a 429 or a timeout is the provider's blip and is rethrown for the job's retry.
 */
export function refusalOf(error: unknown): ProviderRefusal | undefined {
  if (!isUltimateError(error) || error.code !== 'X_OUTBOUND_REFUSED') return undefined;
  const status = error.meta?.['status'];
  if (typeof status !== 'number') return undefined;
  const raw = error.meta?.['detail'];
  const detail = typeof raw === 'string' ? raw : '';
  let body: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = detail === '' ? null : JSON.parse(detail);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = undefined;
  }
  return { status, body, detail };
}
