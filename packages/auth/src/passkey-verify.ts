// Single responsibility: the WebAuthn checks (L3 §7.1 registration, §7.2 assertion) over a
// response the browser forwarded — envelope, `clientDataJSON` type and origin, rp id hash, the UP
// and UV flags, the attested key, the signature. Pure: no store, no clock. Every refusal answers
// `null` plus the name of the check, which the caller logs; the challenge is the caller's to match.

import { base64Url, canonicalBase64UrlBytes } from './base64url';
import { importCoseKey, PASSKEY_ALGORITHMS, verifyCoseSignature } from './cose-key';
import { isRecord } from './json';
import type { PasskeyRelyingParty } from './passkey-config';
import {
  type AuthenticatorData,
  FLAG_AT,
  FLAG_UP,
  FLAG_UV,
  parseAttestationObject,
  parseAuthenticatorData,
  parseClientData,
} from './webauthn-data';

/** Which check refused — a log field, never a `cause:`. */
export type PasskeyCheck =
  | 'envelope'
  | 'client-data'
  | 'type'
  | 'origin'
  | 'attestation'
  | 'rp-id'
  | 'user-present'
  | 'user-verified'
  | 'credential-id'
  | 'key'
  | 'signature';

export type Checked<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly check: PasskeyCheck };

const refuse = (check: PasskeyCheck): { readonly ok: false; readonly check: PasskeyCheck } => ({
  ok: false,
  check,
});

/** The parts of a response every ceremony reads before it knows which challenge it answers. */
export interface CeremonyEnvelope {
  readonly credentialId: string;
  readonly challenge: string;
  readonly clientDataJSON: Uint8Array;
  readonly response: Readonly<Record<string, unknown>>;
}

const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

export const rpIdHash = (rpId: string): Promise<Uint8Array> =>
  sha256(new TextEncoder().encode(rpId));

/** `id === rawId`, both canonical base64url; `type` is `public-key`; the client data is ours. */
export function readEnvelope(
  policy: PasskeyRelyingParty,
  raw: unknown,
  type: 'webauthn.create' | 'webauthn.get',
): Checked<CeremonyEnvelope> {
  if (!isRecord(raw) || raw['type'] !== 'public-key' || !isRecord(raw['response'])) {
    return refuse('envelope');
  }
  const id = raw['id'];
  if (canonicalBase64UrlBytes(id) === null || raw['rawId'] !== id || typeof id !== 'string') {
    return refuse('envelope');
  }
  const response = raw['response'];
  const clientDataJSON = canonicalBase64UrlBytes(response['clientDataJSON']);
  const clientData = clientDataJSON === null ? null : parseClientData(clientDataJSON);
  if (clientDataJSON === null || clientData === null) return refuse('client-data');
  if (clientData.type !== type) return refuse('type');
  // An exact match against the declared list — never a prefix, never a host compare — and never
  // from inside a cross-origin iframe, which the declaration did not name.
  if (!policy.origins.includes(clientData.origin) || clientData.crossOrigin) {
    return refuse('origin');
  }
  return {
    ok: true,
    value: { credentialId: id, challenge: clientData.challenge, clientDataJSON, response },
  };
}

/** Checked once per ceremony: our rp, a person present, and that person verified. */
async function checkFlags(
  policy: PasskeyRelyingParty,
  data: AuthenticatorData,
): Promise<PasskeyCheck | null> {
  if (!equalBytes(data.rpIdHash, await rpIdHash(policy.rpId))) return 'rp-id';
  if ((data.flags & FLAG_UP) === 0) return 'user-present';
  if ((data.flags & FLAG_UV) === 0) return 'user-verified';
  return null;
}

export interface AttestedPasskey {
  readonly credentialId: string;
  readonly publicKey: string;
  readonly algorithm: number;
  readonly signCount: number;
  readonly transports: readonly string[];
}

const TRANSPORT = /^[a-z-]{1,32}$/;

/** §7.1 steps 7-27 that need no store. The attestation STATEMENT is not verified: we asked for none. */
export async function verifyAttestation(
  policy: PasskeyRelyingParty,
  envelope: CeremonyEnvelope,
): Promise<Checked<AttestedPasskey>> {
  const attestation = canonicalBase64UrlBytes(envelope.response['attestationObject']);
  const parsed = attestation === null ? null : parseAttestationObject(attestation);
  const data = parsed === null ? null : parseAuthenticatorData(parsed.authData);
  if (data === null) return refuse('attestation');
  const flags = await checkFlags(policy, data);
  if (flags !== null) return refuse(flags);
  if ((data.flags & FLAG_AT) === 0 || data.attested === null) return refuse('attestation');
  if (base64Url(data.attested.credentialId) !== envelope.credentialId)
    return refuse('credential-id');
  const key = await importCoseKey(data.attested.publicKey);
  if (key === null || !PASSKEY_ALGORITHMS.includes(key.algorithm)) return refuse('key');
  const declared = envelope.response['transports'];
  const transports = Array.isArray(declared)
    ? declared.filter((item): item is string => typeof item === 'string' && TRANSPORT.test(item))
    : [];
  return {
    ok: true,
    value: {
      credentialId: envelope.credentialId,
      publicKey: base64Url(data.attested.publicKey),
      algorithm: key.algorithm,
      signCount: data.signCount,
      transports: transports.slice(0, 8),
    },
  };
}

export interface VerifiedAssertion {
  readonly signCount: number;
  /** The `userHandle` the authenticator returned, decoded as text; `null` when it sent none. */
  readonly userHandle: string | null;
  readonly authenticatorData: Uint8Array;
  readonly signature: Uint8Array;
}

/** §7.2 steps 11-21 that need no store, against the key `publicKey` (stored COSE, base64url). */
export async function verifyAssertion(
  policy: PasskeyRelyingParty,
  envelope: CeremonyEnvelope,
  publicKey: string,
): Promise<Checked<VerifiedAssertion>> {
  const authenticatorData = canonicalBase64UrlBytes(envelope.response['authenticatorData']);
  const signature = canonicalBase64UrlBytes(envelope.response['signature']);
  const data = authenticatorData === null ? null : parseAuthenticatorData(authenticatorData);
  if (authenticatorData === null || signature === null || data === null) return refuse('envelope');
  const flags = await checkFlags(policy, data);
  if (flags !== null) return refuse(flags);
  const cose = canonicalBase64UrlBytes(publicKey);
  const key = cose === null ? null : await importCoseKey(cose);
  if (key === null) return refuse('key');
  const signed = new Uint8Array(authenticatorData.length + 32);
  signed.set(authenticatorData);
  signed.set(await sha256(envelope.clientDataJSON), authenticatorData.length);
  if (!(await verifyCoseSignature(key, signature, signed))) return refuse('signature');
  const handle = envelope.response['userHandle'];
  let userHandle: string | null = null;
  if (handle !== undefined && handle !== null) {
    const bytes = canonicalBase64UrlBytes(handle);
    if (bytes === null) return refuse('envelope');
    userHandle = new TextDecoder().decode(bytes);
  }
  return {
    ok: true,
    value: { signCount: data.signCount, userHandle, authenticatorData, signature },
  };
}
