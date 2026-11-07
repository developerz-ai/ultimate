// Single responsibility: the ceremony helpers every passkey suite needs — a real ES256 authenticator,
// the CBOR an attestation object carries, and a harness binding both to a frozen clock and a fresh
// adapter, so two suites driving one ceremony from opposite sides share these rather than drift.
// Not public API: `index.ts` does not re-export it and `files` leaves every `*-fixture.ts` out.

import { frozenClock } from '@ultimat3/core';
import { defineAuth } from './auth';
import { memoryAuthAdapter } from './memory-adapter';
import { passkeyLogin } from './passkey';
import { base64Url, sha256Bytes } from './tokens';

export const RP_ID = 'example.com';
export const ORIGIN = 'https://example.com';
export const USER = 'user-1';

export const encoder = new TextEncoder();

/** An authenticator: one P-256 keypair and the credential id the browser would hand back. */
export interface Authenticator {
  readonly credentialId: Uint8Array;
  readonly key: CryptoKey;
  readonly publicKeyCose: Uint8Array;
}

/** Minimal CBOR, encoder only: the two maps a ceremony carries, and nothing else. */
export function cborHead(major: number, value: number): number[] {
  if (value < 24) return [(major << 5) | value];
  if (value < 256) return [(major << 5) | 24, value];
  if (value < 65_536) return [(major << 5) | 25, value >> 8, value & 0xff];
  return [
    (major << 5) | 26,
    value >>> 24,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

export const cborInt = (value: number): number[] =>
  value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);

export const cborText = (value: string): number[] => {
  const bytes = encoder.encode(value);
  return [...cborHead(3, bytes.length), ...bytes];
};

export const cborBytes = (value: Uint8Array): number[] => [
  ...cborHead(2, value.length),
  ...Array.from(value),
];

/**
 * The COSE key for a generated P-256 pair, built from the JWK WebCrypto exports. -7 is ES256 and 2
 * is EC2 — the two identifiers `coseToJwk` refuses anything else for.
 */
export async function coseFor(key: CryptoKey): Promise<Uint8Array> {
  const jwk = await crypto.subtle.exportKey('jwk', key);
  if (jwk.x === undefined || jwk.y === undefined) throw new TypeError('no x/y on the exported JWK');
  return new Uint8Array([
    ...cborHead(5, 5),
    ...cborInt(1),
    ...cborInt(2),
    ...cborInt(3),
    ...cborInt(-7),
    ...cborInt(-1),
    ...cborInt(1),
    ...cborInt(-2),
    ...cborBytes(base64ToBytes(jwk.x)),
    ...cborInt(-3),
    ...cborBytes(base64ToBytes(jwk.y)),
  ]);
}

export const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
};

export async function newAuthenticator(): Promise<Authenticator> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return {
    credentialId: crypto.getRandomValues(new Uint8Array(16)),
    key: pair.privateKey,
    publicKeyCose: await coseFor(pair.publicKey),
  };
}

/** rpIdHash ‖ flags ‖ counter, plus the attested credential data when the `AT` flag is set. */
export function authenticatorData(input: {
  readonly rpId: string;
  readonly flags: number;
  readonly signCount: number;
  readonly credential?: Authenticator;
}): Uint8Array<ArrayBuffer> {
  const head = [
    ...Array.from(sha256Bytes(input.rpId)),
    input.flags,
    (input.signCount >>> 24) & 0xff,
    (input.signCount >>> 16) & 0xff,
    (input.signCount >>> 8) & 0xff,
    input.signCount & 0xff,
  ];
  if (input.credential === undefined) return new Uint8Array(head);
  const { credentialId, publicKeyCose } = input.credential;
  return new Uint8Array([
    ...head,
    ...new Array<number>(16).fill(0), // aaguid
    (credentialId.length >> 8) & 0xff,
    credentialId.length & 0xff,
    ...Array.from(credentialId),
    ...Array.from(publicKeyCose),
  ]);
}

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_AT = 0x40;

export const clientDataOf = (input: { type: string; challenge: string; origin: string }): string =>
  JSON.stringify({
    type: input.type,
    challenge: input.challenge,
    origin: input.origin,
    crossOrigin: false,
  });

/** What the authenticator signs: authenticatorData ‖ sha256(clientDataJSON), and nothing else. */
export const signedBytes = (
  authenticator: Uint8Array,
  clientDataJson: string,
): Uint8Array<ArrayBuffer> => {
  const hash = sha256Bytes(clientDataJson);
  const out = new Uint8Array(authenticator.length + 32);
  out.set(authenticator, 0);
  out.set(hash, authenticator.length);
  return out;
};

export const signWith = async (
  key: CryptoKey,
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data));

/** One harness: a frozen clock, a fresh adapter, and the ceremony helpers bound to both. */
export function harness(startAt = '2026-11-06T00:00:00.000Z') {
  const clock = frozenClock(startAt);
  const adapter = memoryAuthAdapter(clock);
  const auth = defineAuth({
    adapter,
    clock,
    passkeys: { rpId: RP_ID, origins: [ORIGIN, 'https://app.example.com'] },
  });
  const login = passkeyLogin(auth);

  /** Register a fresh authenticator end to end, answering the options the RP actually minted. */
  const register = async (): Promise<Authenticator> => {
    const options = await login.registerOptions({ userId: USER, username: 'ada@example.com' });
    const authenticator = await newAuthenticator();
    const clientDataJSON = clientDataOf({
      type: 'webauthn.create',
      challenge: options.challenge,
      origin: ORIGIN,
    });
    const authData = authenticatorData({
      rpId: RP_ID,
      flags: FLAG_UP | FLAG_UV | FLAG_AT,
      signCount: 0,
      credential: authenticator,
    });
    // fmt 'none': the attestation object is the format, the authData and nothing else.
    const attestationObject = new Uint8Array([
      ...cborHead(5, 3),
      ...cborText('fmt'),
      ...cborText('none'),
      ...cborText('attStmt'),
      ...cborHead(5, 0),
      ...cborText('authData'),
      ...cborBytes(authData),
    ]);
    await login.register({
      response: {
        id: base64Url(authenticator.credentialId),
        rawId: base64Url(authenticator.credentialId),
        type: 'public-key',
        response: {
          clientDataJSON: base64Url(encoder.encode(clientDataJSON)),
          attestationObject: base64Url(attestationObject),
          transports: ['internal'],
        },
      },
    });
    return authenticator;
  };

  /** Build the assertion a browser would return for `challenge`, without calling login(). */
  const assertionFor = async (input: {
    readonly authenticator: Authenticator;
    readonly challenge: string;
    readonly signCount: number;
    readonly origin?: string;
    readonly key?: CryptoKey;
    readonly tamper?: boolean;
  }) => {
    const clientDataJSON = clientDataOf({
      type: 'webauthn.get',
      challenge: input.challenge,
      origin: input.origin ?? ORIGIN,
    });
    const authData = authenticatorData({
      rpId: RP_ID,
      flags: FLAG_UP | FLAG_UV,
      signCount: input.signCount,
    });
    const signature = await signWith(
      input.key ?? input.authenticator.key,
      signedBytes(authData, clientDataJSON),
    );
    if (input.tamper === true) signature[10] = (signature[10] ?? 0) ^ 0xff;
    return {
      id: base64Url(input.authenticator.credentialId),
      rawId: base64Url(input.authenticator.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: base64Url(encoder.encode(clientDataJSON)),
        authenticatorData: base64Url(authData),
        signature: base64Url(signature),
      },
    };
  };

  return { clock, adapter, auth, login, register, assertionFor };
}
