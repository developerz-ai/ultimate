// Single responsibility: `defineAuth({ passkeys })` — the relying party every ceremony verifies
// against, refused where it is written. An rp id no origin sits under, or an origin that is not
// one, would otherwise surface as every passkey in production failing `X_PASSKEY_INVALID`.

import type { Auth } from './auth';
import { passkeyConfigInvalid, passkeysUndeclared } from './passkey-errors';
import { assertFiniteAuthCount } from './policy-numbers';

/** Five minutes: long enough for a person to find their phone, short enough to be single-use. */
export const DEFAULT_PASSKEY_CHALLENGE_TTL_MS = 5 * 60_000;

export interface PasskeyPolicyInput {
  /** The bare host the credentials are scoped to — `example.com`, never a URL. */
  readonly rpId: string;
  /** Every exact origin a ceremony may arrive from. Each must be on `rpId` or a subdomain of it. */
  readonly origins: readonly string[];
  /** Shown by the authenticator at registration. Defaults to `rpId`. */
  readonly rpName?: string | undefined;
  /** How long issued options stay redeemable. Defaults to `DEFAULT_PASSKEY_CHALLENGE_TTL_MS`. */
  readonly challengeTtlMs?: number | undefined;
}

/** The resolved block, read by `passkeyLogin`, `passkeyStepUp` and `verifyPasskeyEvidence`. */
export interface PasskeyPolicy {
  readonly rpId: string;
  readonly origins: readonly string[];
  readonly rpName: string;
  readonly challengeTtlMs: number;
}

/** What a signature is checked against — all a verifier in another process needs. */
export type PasskeyRelyingParty = Pick<PasskeyPolicy, 'rpId' | 'origins'>;

/** A DNS name: labels of letters, digits and inner hyphens. An IP address is not an rp id (§5.1.4). */
const HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV4 = /^\d+(?:\.\d+){3}$/;

export function resolvePasskeyPolicy(input: PasskeyPolicyInput): PasskeyPolicy {
  const declared: { readonly rpId?: unknown; readonly origins?: unknown } = input;
  const { rpId, origins } = declared;
  if (typeof rpId !== 'string' || !HOST.test(rpId) || IPV4.test(rpId)) {
    throw passkeyConfigInvalid('rpId', rpId, 'it is not a bare lowercase host name');
  }
  if (!Array.isArray(origins) || origins.length === 0) {
    throw passkeyConfigInvalid('origins', origins, 'it must list at least one origin');
  }
  const checked = origins.map((origin: unknown) => checkOrigin(rpId, origin));
  const ttl = assertFiniteAuthCount(
    'passkeys.challengeTtlMs',
    input.challengeTtlMs ?? DEFAULT_PASSKEY_CHALLENGE_TTL_MS,
    'an issued passkey challenge would never expire',
    1,
  );
  return Object.freeze({
    rpId,
    origins: Object.freeze(checked),
    rpName: input.rpName ?? rpId,
    challengeTtlMs: ttl,
  });
}

/**
 * Exactly an origin (`URL.origin` round-trips it), on the rp id or under it, and https — except
 * `http://localhost`, the one insecure origin browsers run WebAuthn on.
 */
function checkOrigin(rpId: string, origin: unknown): string {
  let url: URL | null = null;
  try {
    url = typeof origin === 'string' ? new URL(origin) : null;
  } catch {
    url = null;
  }
  if (url === null || url.origin !== origin) {
    throw passkeyConfigInvalid('origins', origin, 'it is not an origin (scheme://host[:port])');
  }
  const secure =
    url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost');
  if (!secure) {
    throw passkeyConfigInvalid('origins', origin, 'only https, or http://localhost, runs WebAuthn');
  }
  if (url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`)) {
    throw passkeyConfigInvalid('origins', origin, `its host is not ${rpId} or a subdomain of it`);
  }
  return origin;
}

/** The resolved block of an `Auth`, or the refusal naming where to declare it. */
export function passkeyPolicyOf(auth: Auth, factory: string): PasskeyPolicy {
  if (auth.passkeys === undefined) throw passkeysUndeclared(factory);
  return auth.passkeys;
}
