// Single responsibility: the WebAuthn sign-in mechanism — the ceremony options a browser answers,
// the single-use challenge registry, and the verification of an answer. One mechanism, several
// files, each one job: records are `passkey-store.ts`, refusals `passkey-errors.ts`, hostile byte
// strings `passkey-wire.ts`, the relying party `passkey-config.ts`, step-up `passkey-step-up.ts`.
//
// `crypto.subtle` verifies ES256, which is all an assertion needs — the primitive `jwks.ts` already
// uses for a JWT, so this costs no dependency. Attestation trust chains are deliberately NOT
// implemented: only `fmt: 'none'` is accepted, which is what `attestation: 'none'` asks a browser
// for, so a credential's provenance is stated rather than verified.
//
// SINGLE USE, and where it lives. A challenge is one row in a bounded in-process map, consumed by
// the verification that reads it, so a replayed ceremony finds nothing left to consume — one
// process' worth of state, exactly as `memoryAuthLimiter` is. Not the only replay defence:
// `updatePasskeyUsage` is a compare-and-set on the authenticator's counter, and that one IS shared.
//
// Every `cause` interpolates a value an attacker chose. None is escaped locally: `AuthError` runs
// all five fields through `singleLine()`, the contract `passkey-errors.ts` states for the same reason.

import { renderCauseValue, uuidV7 } from '@ultimat3/core';
import type { Auth } from './auth';
import { passkeysOf } from './passkey-config';
import { passkeyChallengeExpired, passkeyInvalid } from './passkey-errors';
import type { PasskeyCredential, PasskeyStore } from './passkey-store';
import {
  attestationBytes,
  authenticatorBytes,
  cborMap,
  clientDataBytes,
  coseToJwk,
  parseAuthenticatorData,
  parseClientData,
  sameBytes,
  signatureBytes,
  signatureField,
} from './passkey-wire';
import { base64Url, randomBytes, sha256Bytes } from './tokens';

/** Not a security value: the challenge ttl is. How long a browser is given to answer. */
const PASSKEY_TIMEOUT_MS = 120_000;
/** How long a minted challenge stays answerable. */
export const PASSKEY_CHALLENGE_TTL_MS = 300_000;
/** Bounded, so a spray of options() calls is not memory the caller chooses. */
const PENDING_CHALLENGE_CAP = 10_000;
/** Authenticator-data flags, WebAuthn §6.1. */
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
/** COSE ES256, the one algorithm the options offer. */
const COSE_ALG_ES256 = -7;

// ── the pending-challenge registry ──────────────────────────────────────────────────────────────

export interface PasskeyCeremony {
  readonly purpose: 'register' | 'login';
  readonly userId: string;
  /**
   * The server's own digest of the request this ceremony authorises. Empty for a plain sign-in; on a
   * step-up it is what the assertion becomes evidence FOR, read back from THIS record and never from
   * anything the client posted.
   */
  readonly requestDigest: string;
  readonly expiresAt: Date;
}

const pending = new Map<string, PasskeyCeremony>();

/** Record a minted challenge, sweeping expired rows and holding the table at its cap. */
export function bindPasskeyChallenge(input: {
  readonly challenge: string;
  readonly ceremony: PasskeyCeremony;
  readonly now: Date;
}): void {
  const at = input.now.getTime();
  for (const [key, value] of pending) if (value.expiresAt.getTime() <= at) pending.delete(key);
  // Insertion-ordered, so the first key is the oldest — an eviction is the least-recently issued.
  while (pending.size >= PENDING_CHALLENGE_CAP) {
    const oldest = pending.keys().next();
    if (oldest.done === true) break;
    pending.delete(oldest.value);
  }
  pending.set(input.challenge, input.ceremony);
}

/**
 * Read AND consume. An unknown challenge is a replay — the one code every rejected ceremony shares,
 * because naming the half that failed tells an attacker which half to fix. A known challenge past
 * its ttl is the honest refusal a caller may retry with nothing else changed.
 */
export function takePasskeyChallenge(input: {
  readonly challenge: string;
  readonly purpose: PasskeyCeremony['purpose'];
  readonly now: Date;
}): PasskeyCeremony {
  const ceremony = pending.get(input.challenge);
  if (ceremony === undefined) {
    throw passkeyInvalid(
      `the ${input.purpose} ceremony's challenge ${renderCauseValue(input.challenge)} was never issued or has already been answered, so this assertion is a replay`,
    );
  }
  pending.delete(input.challenge);
  if (ceremony.purpose !== input.purpose) {
    throw passkeyInvalid(
      `the challenge ${renderCauseValue(input.challenge)} was issued for a ${ceremony.purpose} ceremony and answered by a ${input.purpose} one`,
    );
  }
  if (ceremony.expiresAt.getTime() <= input.now.getTime()) {
    throw passkeyChallengeExpired({
      purpose: `${input.purpose} passkey`,
      expiredAt: ceremony.expiresAt,
    });
  }
  return ceremony;
}

// ── the WebAuthn JSON shapes ────────────────────────────────────────────────────────────────────

export interface PasskeyCredentialDescriptor {
  readonly id: string;
  readonly type: 'public-key';
  readonly transports?: readonly string[];
}

export interface PasskeyRegisterOptions {
  readonly challenge: string;
  readonly rp: { readonly id: string; readonly name: string };
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
  readonly pubKeyCredParams: readonly { readonly type: 'public-key'; readonly alg: number }[];
  readonly timeout: number;
  readonly attestation: 'none';
  readonly authenticatorSelection: {
    readonly residentKey: 'discouraged';
    readonly userVerification: 'required';
  };
  readonly excludeCredentials: readonly PasskeyCredentialDescriptor[];
}

export interface PasskeyLoginOptions {
  readonly challenge: string;
  readonly rpId: string;
  readonly timeout: number;
  readonly userVerification: 'required';
  readonly allowCredentials: readonly PasskeyCredentialDescriptor[];
}

/** `PublicKeyCredential.toJSON()` of a `navigator.credentials.create()` answer. */
export interface PasskeyRegistrationResponse {
  readonly id: string;
  readonly rawId: string;
  readonly type: string;
  readonly response: {
    readonly clientDataJSON: string;
    readonly attestationObject: string;
    readonly transports?: readonly string[];
  };
}

/** `PublicKeyCredential.toJSON()` of a `navigator.credentials.get()` answer. */
export interface PasskeyAssertionResponse {
  readonly id: string;
  readonly rawId: string;
  readonly type: string;
  readonly response: {
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
    readonly userHandle?: string | null;
  };
}

export interface PasskeySignIn {
  readonly userId: string;
  readonly credentialId: string;
  readonly signCount: number;
  readonly verifiedAt: Date;
}

export interface PasskeyLogin {
  readonly registerOptions: (input: {
    readonly userId: string;
    readonly username: string;
    readonly displayName?: string | undefined;
  }) => Promise<PasskeyRegisterOptions>;
  readonly register: (input: {
    readonly response: PasskeyRegistrationResponse;
  }) => Promise<PasskeyCredential>;
  readonly loginOptions: (input: {
    readonly userId: string;
    /** Set only by a step-up ceremony, which binds the assertion to the request digest. */
    readonly requestDigest?: string | undefined;
    /** Set only by a step-up ceremony, whose challenge is derived from that digest. */
    readonly challenge?: string | undefined;
  }) => Promise<PasskeyLoginOptions>;
  readonly login: (input: {
    readonly assertion: PasskeyAssertionResponse;
  }) => Promise<PasskeySignIn>;
}

export interface VerifiedAssertion {
  readonly userId: string;
  readonly credential: PasskeyCredential;
  /** Read back from the registry, never from the answer: this is where a step-up gets its digest. */
  readonly ceremony: PasskeyCeremony;
  readonly clientDataJson: string;
  readonly authenticatorData: string;
  readonly signature: string;
  readonly signCount: number;
  readonly verifiedAt: Date;
}

// ── the shared ceremony checks ─────────────────────────────────────────────────────────────────

/** `rpIdHash` and both flags: what the signature covers and therefore cannot vouch for by itself. */
function screenCeremony(
  auth: Auth,
  clientData: { readonly type: string; readonly origin: string },
  authenticatorData: { readonly rpIdHash: Uint8Array; readonly flags: number },
  expectedType: string,
): void {
  const config = passkeysOf(auth);
  if (clientData.type !== expectedType) {
    throw passkeyInvalid(
      `the client data says this is a ${renderCauseValue(clientData.type)} ceremony, and this call answers only ${expectedType}`,
    );
  }
  if (!config.origins.includes(clientData.origin)) {
    throw passkeyInvalid(
      `the ceremony came from ${renderCauseValue(clientData.origin)}, which defineAuth({ passkeys: { origins } }) does not list`,
    );
  }
  if (!sameBytes(authenticatorData.rpIdHash, sha256Bytes(config.rpId))) {
    throw passkeyInvalid(
      `the authenticator signed an rpIdHash that is not sha256(${renderCauseValue(config.rpId)}), so this credential belongs to another relying party`,
    );
  }
  if ((authenticatorData.flags & FLAG_USER_PRESENT) === 0) {
    refuse('the authenticator did not assert user presence, so no human was there');
  }
  if ((authenticatorData.flags & FLAG_USER_VERIFIED) === 0) {
    refuse(
      'the authenticator did not verify the user, and every ceremony here requires userVerification: that is what makes an assertion evidence rather than a tap',
    );
  }
}

/** A user handle that is stable, opaque and 32 bytes — WebAuthn caps it at 64. */
const userHandleOf = (userId: string): string => base64Url(sha256Bytes(userId));

const descriptors = (records: readonly PasskeyCredential[]): PasskeyCredentialDescriptor[] =>
  records.map((record) => ({
    id: record.credentialId,
    type: 'public-key' as const,
    transports: [...record.transports],
  }));

// ── the mechanism ──────────────────────────────────────────────────────────────────────────────

export function passkeyLogin(auth: Auth): PasskeyLogin {
  const store: PasskeyStore = auth.adapter;

  return {
    async registerOptions(input): Promise<PasskeyRegisterOptions> {
      const config = passkeysOf(auth);
      const challenge = base64Url(randomBytes(32));
      const now = auth.clock.now();
      const existing = await store.listPasskeys(input.userId);
      bindPasskeyChallenge({
        challenge,
        ceremony: {
          purpose: 'register',
          userId: input.userId,
          requestDigest: '',
          expiresAt: new Date(now.getTime() + PASSKEY_CHALLENGE_TTL_MS),
        },
        now,
      });
      return {
        challenge,
        // `name` is the rpId: `PasskeyConfig` is the two fields a ceremony cannot be safe without,
        // and an app that wants a display name wraps this call. One way to do each thing.
        rp: { id: config.rpId, name: config.rpId },
        user: {
          id: userHandleOf(input.userId),
          name: input.username,
          displayName: input.displayName ?? input.username,
        },
        pubKeyCredParams: [{ type: 'public-key', alg: COSE_ALG_ES256 }],
        timeout: PASSKEY_TIMEOUT_MS,
        attestation: 'none',
        authenticatorSelection: { residentKey: 'discouraged', userVerification: 'required' },
        excludeCredentials: descriptors(existing),
      };
    },

    async register(input): Promise<PasskeyCredential> {
      const answer = input.response;
      const clientData = parseClientData(clientDataBytes(answer.response.clientDataJSON));
      const attestation = cborMap(attestationBytes(answer.response.attestationObject));
      const format = attestation.get('fmt');
      if (format !== 'none') {
        throw passkeyInvalid(
          `the attestation format is ${renderCauseValue(format)}, and only 'none' is accepted: this package verifies signatures, not attestation trust chains`,
        );
      }
      const rawAuthData = attestation.get('authData');
      if (!(rawAuthData instanceof Uint8Array))
        refuse('the attestation object carries no authData');
      const authenticatorData = parseAuthenticatorData(rawAuthData);
      const ceremony = takePasskeyChallenge({
        challenge: clientData.challenge,
        purpose: 'register',
        now: auth.clock.now(),
      });
      screenCeremony(auth, clientData, authenticatorData, 'webauthn.create');
      const { credentialId, publicKeyCose } = authenticatorData;
      if (credentialId === null || publicKeyCose === null) {
        refuse('the attested credential data carries no credential id or no public key');
      }
      if (credentialId !== answer.rawId) {
        throw passkeyInvalid(
          `the credential id in the authenticator data (${renderCauseValue(credentialId)}) is not the rawId the browser returned`,
        );
      }
      // Importable NOW: a key this package cannot parse is a credential that fails at its first
      // sign-in, by which time the user has already enrolled and gone.
      coseToJwk(publicKeyCose);
      const taken = await store.findPasskeyByCredentialId(credentialId);
      if (taken !== null && taken.userId !== ceremony.userId) {
        refuse(
          'that authenticator is already registered to another user, and re-registering it here would transfer an existing credential rather than create one',
        );
      }
      const transports = answer.response.transports;
      return await store.putPasskey({
        id: uuidV7(auth.clock),
        userId: ceremony.userId,
        credentialId,
        publicKeyCose,
        signCount: authenticatorData.signCount,
        transports: Array.isArray(transports)
          ? transports.filter((entry): entry is string => typeof entry === 'string')
          : [],
        createdAt: auth.clock.now(),
        lastUsedAt: null,
      });
    },

    async loginOptions(input): Promise<PasskeyLoginOptions> {
      const config = passkeysOf(auth);
      const now = auth.clock.now();
      const challenge = input.challenge ?? base64Url(randomBytes(32));
      const credentials = await store.listPasskeys(input.userId);
      bindPasskeyChallenge({
        challenge,
        ceremony: {
          purpose: 'login',
          userId: input.userId,
          requestDigest: input.requestDigest ?? '',
          expiresAt: new Date(now.getTime() + PASSKEY_CHALLENGE_TTL_MS),
        },
        now,
      });
      return {
        challenge,
        rpId: config.rpId,
        timeout: PASSKEY_TIMEOUT_MS,
        userVerification: 'required',
        allowCredentials: descriptors(credentials),
      };
    },

    async login(input): Promise<PasskeySignIn> {
      const verified = await verifySignIn(auth, input.assertion);
      return {
        userId: verified.userId,
        credentialId: verified.credential.credentialId,
        signCount: verified.signCount,
        verifiedAt: verified.verifiedAt,
      };
    },
  };
}

/**
 * A verified sign-in: the verification PLUS the counter write. Both uses — `login()`, which projects
 * it to `PasskeySignIn`, and step-up, which needs `ceremony` — go through here, so the clone check
 * cannot be remembered by one and forgotten by the other.
 */
export async function verifySignIn(
  auth: Auth,
  assertion: PasskeyAssertionResponse,
): Promise<VerifiedAssertion> {
  const verified = await verifyAssertion(auth, assertion);
  // A compare-and-set: `false` is the storage half of the replay defence, covering what the
  // challenge map cannot — two processes, one assertion. A counter of 0 means the authenticator does
  // not count, which WebAuthn allows and which therefore proves nothing either way.
  if (verified.signCount > 0) {
    const advanced = await auth.adapter.updatePasskeyUsage(
      verified.credential.id,
      verified.signCount,
      verified.verifiedAt,
    );
    if (!advanced) {
      refuse(
        'the authenticator’s counter did not move forward, so this assertion is a replay or a cloned credential',
      );
    }
  }
  return verified;
}

/** Throw `X_PASSKEY_INVALID` with this detail; typed `never`, so a refusal reads as one line. */
/** A function DECLARATION, not a `const` arrow: only this form narrows what follows an `if`. */
function refuse(detail: string): never {
  throw passkeyInvalid(detail);
}

/**
 * The verification both uses share at the crypto layer: a sign-in and a step-up differ in what they
 * do with the result, never in what they accept as one. `X_PASSKEY_INVALID` for everything an answer gets
 * wrong — naming the half that failed tells an attacker which half to fix.
 */
export async function verifyAssertion(
  auth: Auth,
  assertion: PasskeyAssertionResponse,
): Promise<VerifiedAssertion> {
  const clientData = parseClientData(clientDataBytes(assertion.response.clientDataJSON));
  const rawAuthData = authenticatorBytes(assertion.response.authenticatorData);
  const signature = signatureField(assertion.response.signature);
  const authenticatorData = parseAuthenticatorData(rawAuthData);
  const verifiedAt = auth.clock.now();
  // Consumed before anything is looked up: a challenge that was answered once is gone even if the
  // answer is then refused, so a failed attempt cannot be retried against the same challenge.
  const ceremony = takePasskeyChallenge({
    challenge: clientData.challenge,
    purpose: 'login',
    now: verifiedAt,
  });
  if (typeof assertion.rawId !== 'string' || assertion.rawId === '') {
    refuse('the assertion carries no rawId');
  }
  const credential = await auth.adapter.findPasskeyByCredentialId(assertion.rawId);
  if (credential === null) {
    throw passkeyInvalid(
      `no passkey is registered under ${renderCauseValue(assertion.rawId)}, so there is no public key to verify this signature with`,
    );
  }
  if (credential.userId !== ceremony.userId) {
    refuse('the credential belongs to a different user than the one this challenge was issued for');
  }
  screenCeremony(auth, clientData, authenticatorData, 'webauthn.get');
  // The signature covers authenticatorData ‖ sha256(clientDataJSON), and nothing else — so the
  // challenge, origin and rpId checked above are the ones the authenticator actually signed.
  const signed = new Uint8Array(rawAuthData.length + 32);
  signed.set(rawAuthData, 0);
  signed.set(sha256Bytes(clientData.raw), rawAuthData.length);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'jwk',
      coseToJwk(credential.publicKeyCose),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  } catch {
    // A stored key this package cannot import is a refused ceremony, never a 500 on a credential
    // someone enrolled legitimately.
    return refuse(
      'the stored public key is not an ES256 key WebCrypto can import, so no signature can be checked against it',
    );
  }
  const algorithm: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' };
  let valid = false;
  try {
    valid = await crypto.subtle.verify(algorithm, key, signatureBytes(signature), signed);
  } catch {
    return refuse('the signature is not a shape the ES256 verifier accepts');
  }
  if (!valid) {
    refuse(
      'the signature does not match authenticatorData ‖ sha256(clientDataJSON) under the stored public key',
    );
  }
  return {
    userId: credential.userId,
    credential,
    ceremony,
    clientDataJson: clientData.raw,
    authenticatorData: base64Url(rawAuthData),
    signature: base64Url(signature),
    signCount: authenticatorData.signCount,
    verifiedAt,
  };
}
