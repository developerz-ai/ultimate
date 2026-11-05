// Single responsibility: verifying a workload's own JWT and turning it into a `ServiceIdentity`.
// Before this, `ServiceIdentity` was a plain struct with no non-test caller and nothing in the
// framework verified a service credential at all — no workload identity, no `client_credentials`,
// no token exchange — so two Ultimate services could only trust each other through a long-lived
// shared secret in an env var, with no rotation and no per-caller identity.
//
// One function covers the three shapes in practice, because they are all the same JWT: a
// Kubernetes projected service-account token, a SPIFFE JWT-SVID, and a cloud IMDS token. It is
// also the shape RFC 8693's `subject_token` takes, so a token-exchange endpoint reads through it.
//
// mTLS is deliberately out of scope: TLS termination is the mesh's job (axiom 7), and the
// framework's part is reading a trusted `x-forwarded-client-cert` through `@ultimat3/http`'s
// trusted-proxy seam — which is that package's to own, not this one's.

import type { Clock } from '@ultimat3/core';
import { AuthError } from './errors';
import { ID_TOKEN_CLOCK_SKEW_MS } from './id-token';
import { decodeJwtSegment } from './json';
import { type JwksKeySource, verifyJwtSignature } from './jwks';
import type { ServiceIdentity } from './policy-bridge';

/** The claims a workload token is read for. Everything else the issuer sends is ignored. */
export interface WorkloadClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: readonly string[];
  readonly exp: number;
  readonly nbf?: number | undefined;
  readonly iat?: number | undefined;
  /** `scope` (space-delimited, RFC 8693 / OAuth) or `scp` (an array). Absent means none. */
  readonly scopes: readonly string[];
}

export interface WorkloadToken {
  readonly claims: WorkloadClaims;
  /** Feed this to `actorFromService()` — the same funnel every other credential goes through. */
  readonly identity: ServiceIdentity;
  /**
   * The whole decoded payload, read only after the signature, issuer, audience and time bounds
   * held: an issuer's own claim (`tid`, `groups`, `azp`) is the app's to judge, and re-decoding the
   * token to reach it is a second parser beside this one.
   */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** Which check refused a token — a name for a log line, never a claim's value. */
export type WorkloadCheck =
  | 'signature'
  | 'payload'
  | 'subject'
  | 'expiry'
  | 'issuer'
  | 'audience'
  | 'not-before';

export type WorkloadTokenCheck =
  | { readonly ok: true; readonly token: WorkloadToken }
  | { readonly ok: false; readonly check: WorkloadCheck; readonly reason: string };

export interface VerifyWorkloadTokenInput {
  readonly token: string;
  /** Every issuer this caller may claim. A list, never a wildcard: an unpinned `iss` is no check. */
  readonly issuers: readonly string[];
  /** This service's own audience. A token addressed elsewhere is a token being replayed here. */
  readonly audience: string;
  /** Required. There is no trusted-channel exemption for a token that arrived in a header. */
  readonly keys: JwksKeySource;
  readonly clock: Clock;
  /** Optional tenant, when the deployment gives a workload one. Never guessed from the token. */
  readonly orgId?: string | null | undefined;
}

const refused = (reason: string): AuthError =>
  new AuthError({
    code: 'X_UNAUTHENTICATED',
    cause: `the presented workload token was refused: ${reason}`,
    // A service credential names no human, so a precise cause enumerates nothing — and the
    // reader of this line is an operator holding a misconfigured deployment, not an attacker.
    fix: "confirm the workload token's issuer, audience and key set match verifyWorkloadToken({ issuers, audience, keys })",
  });

const readScopes = (payload: Record<string, unknown>): readonly string[] => {
  const scope = payload['scope'];
  if (typeof scope === 'string') return scope.split(' ').filter((one) => one !== '');
  const scp = payload['scp'];
  return Array.isArray(scp) ? scp.filter((one): one is string => typeof one === 'string') : [];
};

const readAudience = (value: unknown): readonly string[] => {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : [];
};

/**
 * Signature first, then issuer, audience and the two time bounds. The order matters for the same
 * reason it does in `verifyIdToken`: a claim is only worth reading once something proved who
 * wrote it, and every check below would otherwise pass for a token the caller minted themselves.
 */
export async function verifyWorkloadToken(input: VerifyWorkloadTokenInput): Promise<WorkloadToken> {
  const checked = await checkWorkloadToken(input);
  if (!checked.ok) throw refused(checked.reason);
  return checked.token;
}

const refusal = (check: WorkloadCheck, reason: string): WorkloadTokenCheck => ({
  ok: false,
  check,
  reason,
});

/**
 * `verifyWorkloadToken`'s checks as a verdict rather than a throw, naming the check that refused —
 * what `jwtBearerResolver` logs. A key source that throws still throws: an unreadable key set is
 * not a verdict on the token, and the caller decides what it is.
 */
export async function checkWorkloadToken(
  input: VerifyWorkloadTokenInput,
): Promise<WorkloadTokenCheck> {
  if (!(await verifyJwtSignature(input.token, input.keys))) {
    return refusal('signature', 'the signature does not verify against the published key set');
  }

  const payloadSegment = input.token.split('.')[1];
  const parsed = payloadSegment === undefined ? null : decodeJwtSegment(payloadSegment);
  if (parsed === null) {
    return refusal('payload', 'the payload is not base64url-encoded JSON describing an object');
  }

  const iss = parsed['iss'];
  const sub = parsed['sub'];
  const exp = parsed['exp'];
  if (typeof iss !== 'string' || typeof sub !== 'string' || sub === '') {
    return refusal('subject', 'the payload carries no iss or sub');
  }
  if (typeof exp !== 'number') return refusal('expiry', 'the payload carries no numeric exp');
  if (!input.issuers.includes(iss)) {
    return refusal('issuer', 'the issuer is not one this service accepts');
  }

  const aud = readAudience(parsed['aud']);
  if (!aud.includes(input.audience)) {
    return refusal('audience', 'the token is addressed to another audience');
  }

  const nowMs = input.clock.now().getTime();
  // The same skew the id token path allows, from the same declaration: two servers rarely agree
  // on the second, and a second number here would drift from that one.
  if (exp * 1000 + ID_TOKEN_CLOCK_SKEW_MS <= nowMs) {
    return refusal('expiry', 'the token is already expired');
  }
  const nbf = parsed['nbf'];
  if (typeof nbf === 'number' && nbf * 1000 - ID_TOKEN_CLOCK_SKEW_MS > nowMs) {
    return refusal('not-before', 'the token is not valid yet');
  }
  const iat = parsed['iat'];

  const claims: WorkloadClaims = {
    iss,
    sub,
    aud,
    exp,
    scopes: readScopes(parsed),
    ...(typeof nbf === 'number' ? { nbf } : {}),
    ...(typeof iat === 'number' ? { iat } : {}),
  };
  return {
    ok: true,
    token: {
      claims,
      identity: {
        // The SPIFFE ID, the service account's `system:serviceaccount:ns:name`, or the IMDS
        // principal — whichever the issuer put there. Never rewritten, so a trace names the caller.
        id: claims.sub,
        scopes: claims.scopes,
        ...(input.orgId === undefined ? {} : { orgId: input.orgId }),
      },
      raw: parsed,
    },
  };
}
