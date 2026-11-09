// Single responsibility: a SOFTWARE authenticator on WebCrypto — it mints real ES256 / RS256
// credentials and signs real assertions, the bytes a platform authenticator sends, so a test runs
// a passkey ceremony end to end against the real verifier. Public as `@ultimat3/auth/soft-authenticator`, the one
// path an app's test and this package's own suites share.

import { base64Url, base64UrlBytes } from './base64url';
import type { CborValue } from './cbor';
import { cborEncode } from './cbor-encode';
import type {
  PasskeyAssertionResponse,
  PasskeyCreationOptions,
  PasskeyRegistrationResponse,
  PasskeyRequestOptions,
} from './passkey-wire';
import { FLAG_AT, FLAG_UP, FLAG_UV } from './webauthn-data';

const concat = (...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));

const u32 = (value: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
};

/** Raw `r || s` → strict DER, as an authenticator encodes an ES256 signature. */
export function ecdsaRawToDer(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array): Uint8Array => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const trimmed = bytes.subarray(start);
    const padded = (trimmed[0] ?? 0) & 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed;
    return concat(Uint8Array.of(0x02, padded.length), padded);
  };
  const body = concat(integer(raw.subarray(0, 32)), integer(raw.subarray(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

/**
 * One knob per check the verifier makes, so a test breaks exactly one: the origin or the
 * `clientDataJSON` type a phishing page would send, another rp id, flags without UV, a counter that
 * went backwards, another ceremony's challenge, a user handle the credential was not made for.
 */
export interface SoftCeremonyOverrides {
  readonly origin?: string | undefined;
  readonly type?: string | undefined;
  readonly rpId?: string | undefined;
  readonly flags?: number | undefined;
  readonly signCount?: number | undefined;
  readonly challenge?: string | undefined;
  readonly userHandle?: string | null | undefined;
  readonly crossOrigin?: boolean | undefined;
}

/** A passkey: `create` answers `newPasskey`'s response, `get` answers `getPasskey`'s. */
export interface SoftAuthenticator {
  /** base64url, as the server stores it. */
  readonly credentialId: string;
  create(
    options: PasskeyCreationOptions,
    overrides?: SoftCeremonyOverrides,
  ): Promise<PasskeyRegistrationResponse>;
  get(
    options: PasskeyRequestOptions,
    overrides?: SoftCeremonyOverrides,
  ): Promise<PasskeyAssertionResponse>;
}

export interface SoftAuthenticatorInput {
  /** The page origin the browser would report: one of `passkeys.origins`, or the test fails. */
  readonly origin: string;
  /** `ES256` by default. */
  readonly algorithm?: 'ES256' | 'RS256' | undefined;
  /** Where the counter starts; `null` is an authenticator that keeps none (always 0). */
  readonly counter?: number | null | undefined;
}

/** A fresh key pair and credential id: one passkey, on no device. */
export async function softAuthenticator(init: SoftAuthenticatorInput): Promise<SoftAuthenticator> {
  const rsa = init.algorithm === 'RS256';
  const pair = rsa
    ? await crypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: Uint8Array.of(1, 0, 1),
          hash: 'SHA-256',
        },
        true,
        ['sign', 'verify'],
      )
    : await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
        'sign',
        'verify',
      ]);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const bytesOf = (field: string | undefined): Uint8Array =>
    base64UrlBytes(field ?? '') ?? new Uint8Array();
  const cose = rsa
    ? cborEncode(
        new Map<number, CborValue>([
          [1, 3],
          [3, -257],
          [-1, bytesOf(jwk.n)],
          [-2, bytesOf(jwk.e)],
        ]),
      )
    : cborEncode(
        new Map<number, CborValue>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, bytesOf(jwk.x)],
          [-3, bytesOf(jwk.y)],
        ]),
      );
  const rawId = crypto.getRandomValues(new Uint8Array(16));
  const credentialId = base64Url(rawId);
  let counter = init.counter === undefined ? 0 : init.counter;
  let userHandle: string | null = null;

  const clientData = (type: string, challenge: string, o: SoftCeremonyOverrides): Uint8Array =>
    new TextEncoder().encode(
      JSON.stringify({
        type: o.type ?? type,
        challenge: o.challenge ?? challenge,
        origin: o.origin ?? init.origin,
        crossOrigin: o.crossOrigin ?? false,
      }),
    );
  const nextCount = (o: SoftCeremonyOverrides): number => {
    if (o.signCount !== undefined) return o.signCount;
    if (counter === null) return 0;
    counter += 1;
    return counter;
  };

  return {
    credentialId,
    async create(options, o = {}) {
      userHandle = options.user.id;
      const authData = concat(
        await sha256(new TextEncoder().encode(o.rpId ?? options.rp.id)),
        Uint8Array.of(o.flags ?? FLAG_UP | FLAG_UV | FLAG_AT),
        u32(o.signCount ?? counter ?? 0),
        new Uint8Array(16),
        Uint8Array.of(rawId.length >> 8, rawId.length & 0xff),
        rawId,
        cose,
      );
      const attestationObject = cborEncode(
        new Map<string, CborValue>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]),
      );
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        response: {
          clientDataJSON: base64Url(clientData('webauthn.create', options.challenge, o)),
          attestationObject: base64Url(attestationObject),
          transports: ['internal', 'hybrid'],
        },
      };
    },
    async get(options, o = {}) {
      const authData = concat(
        await sha256(new TextEncoder().encode(o.rpId ?? options.rpId)),
        Uint8Array.of(o.flags ?? FLAG_UP | FLAG_UV),
        u32(nextCount(o)),
      );
      const data = clientData('webauthn.get', options.challenge, o);
      const signed = concat(authData, await sha256(data));
      const signature = rsa
        ? new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, signed))
        : ecdsaRawToDer(
            new Uint8Array(
              await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, signed),
            ),
          );
      const handle = o.userHandle === undefined ? userHandle : o.userHandle;
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        response: {
          clientDataJSON: base64Url(data),
          authenticatorData: base64Url(authData),
          signature: base64Url(signature),
          userHandle: handle,
        },
      };
    },
  };
}
