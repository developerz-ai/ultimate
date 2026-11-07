// Single responsibility: digest-bound step-up — proof that an assertion collected for request A is
// NOT evidence for request B, that its ttl is read off an injected clock rather than a sleep, and
// that the evidence row survives in the store where a second handle can read it back.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { defineAuth } from './auth';
import { caught } from './auth-fixture';
import { memoryAuthAdapter } from './memory-adapter';
import { passkeyLogin } from './passkey';
import { passkeyStepUp } from './passkey-step-up';
import type { PasskeyStore } from './passkey-store';
import { base64Url, sha256Bytes } from './tokens';

const RP_ID = 'example.com';
const ORIGIN = 'https://example.com';
const USER = 'user-1';
const TTL_MS = 60_000;
/** Two real-looking digests: base64url over the request body, as a server computes them. */
const DIGEST_A = base64Url(sha256Bytes('{"amount":10,"to":"alice"}'));
const DIGEST_B = base64Url(sha256Bytes('{"amount":10000,"to":"mallory"}'));
const SURFACE = 'transfer.confirm';

const encoder = new TextEncoder();
const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
};

const cborHead = (major: number, value: number): number[] => {
  if (value < 24) return [(major << 5) | value];
  if (value < 256) return [(major << 5) | 24, value];
  return [(major << 5) | 25, value >> 8, value & 0xff];
};
const cborInt = (value: number): number[] =>
  value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
const cborText = (value: string): number[] => [
  ...cborHead(3, value.length),
  ...encoder.encode(value),
];
const cborBytes = (value: Uint8Array): number[] => [...cborHead(2, value.length), ...value];

async function coseFor(key: CryptoKey): Promise<Uint8Array> {
  const jwk = await crypto.subtle.exportKey('jwk', key);
  if (jwk.x === undefined || jwk.y === undefined)
    expect.unreachable('the generated P-256 pair exports x and y');
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

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

function authenticatorData(input: {
  readonly rpId: string;
  readonly flags: number;
  readonly signCount: number;
  readonly credential?: { readonly credentialId: Uint8Array; readonly publicKeyCose: Uint8Array };
}): Uint8Array {
  const head = [
    ...sha256Bytes(input.rpId),
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
    ...new Array<number>(16).fill(0),
    (credentialId.length >> 8) & 0xff,
    credentialId.length & 0xff,
    ...credentialId,
    ...publicKeyCose,
  ]);
}

const clientDataOf = (input: { type: string; challenge: string; origin: string }): string =>
  JSON.stringify({
    type: input.type,
    challenge: input.challenge,
    origin: input.origin,
    crossOrigin: false,
  });

const signedBytes = (
  authenticator: Uint8Array,
  clientDataJson: string,
): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(authenticator.length + 32);
  out.set(authenticator, 0);
  out.set(sha256Bytes(clientDataJson), authenticator.length);
  return out;
};

interface Enrolled {
  readonly credentialId: Uint8Array;
  readonly key: CryptoKey;
}

/** A frozen clock, a store, an auth, an enrolled authenticator, and the step-up bound to them. */
async function harness(startAt = '2026-11-06T00:00:00.000Z') {
  const clock = frozenClock(startAt);
  const adapter = memoryAuthAdapter(clock);
  const auth = defineAuth({ adapter, clock, passkeys: { rpId: RP_ID, origins: [ORIGIN] } });
  const login = passkeyLogin(auth);

  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const enrolled: Enrolled = {
    credentialId: crypto.getRandomValues(new Uint8Array(16)),
    key: pair.privateKey,
  };
  const publicKeyCose = await coseFor(pair.publicKey);

  // Enrol through the public seam, so the record under test is the one a browser would create.
  const options = await login.registerOptions({ userId: USER, username: 'ada@example.com' });
  const createClientData = clientDataOf({
    type: 'webauthn.create',
    challenge: options.challenge,
    origin: ORIGIN,
  });
  const authData = authenticatorData({
    rpId: RP_ID,
    flags: FLAG_UP | FLAG_UV | FLAG_AT,
    signCount: 0,
    credential: { credentialId: enrolled.credentialId, publicKeyCose },
  });
  await login.register({
    response: {
      id: base64Url(enrolled.credentialId),
      rawId: base64Url(enrolled.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: base64Url(encoder.encode(createClientData)),
        attestationObject: base64Url(
          new Uint8Array([
            ...cborHead(5, 3),
            ...cborText('fmt'),
            ...cborText('none'),
            ...cborText('attStmt'),
            ...cborHead(5, 0),
            ...cborText('authData'),
            ...cborBytes(authData),
          ]),
        ),
      },
    },
  });

  /** Answer the ceremony `options()` just opened, over whatever challenge it carries. */
  const answer = async (challenge: string, signCount: number) => {
    const clientDataJSON = clientDataOf({ type: 'webauthn.get', challenge, origin: ORIGIN });
    const authData = authenticatorData({ rpId: RP_ID, flags: FLAG_UP | FLAG_UV, signCount });
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        enrolled.key,
        signedBytes(authData, clientDataJSON),
      ),
    );
    return {
      id: base64Url(enrolled.credentialId),
      rawId: base64Url(enrolled.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: base64Url(encoder.encode(clientDataJSON)),
        authenticatorData: base64Url(authData),
        signature: base64Url(signature),
      },
    };
  };

  const stepUp = passkeyStepUp(auth, {
    ttlMs: TTL_MS,
    challenge: ({ input }) => input.requestDigest,
  });

  return { clock, adapter, auth, stepUp, answer };
}

describe('passkeyStepUp binds one assertion to one request digest', () => {
  test('an assertion collected for digest A does NOT satisfy a step-up for digest B', async () => {
    const h = await harness();
    const ceremony = await h.stepUp.options({ userId: USER, requestDigest: DIGEST_A });
    await h.stepUp.verify({ userId: USER, assertion: await h.answer(ceremony.challenge, 1) });

    // The binding, not the plumbing: A is proven and B is the request an attacker would rather
    // have approved. Without the digest on the evidence row this call would succeed.
    const error = await caught(async () =>
      h.stepUp.guard({ userId: USER, requestDigest: DIGEST_B, surface: SURFACE }),
    );
    expect(error?.code).toBe('X_PASSKEY_STEP_UP_REQUIRED');
    expect(error?.cause).toContain(SURFACE);

    // ...and A itself is still covered, so the refusal above is about the digest and nothing else.
    const evidence = await h.stepUp.guard({
      userId: USER,
      requestDigest: DIGEST_A,
      surface: SURFACE,
    });
    expect(evidence.requestDigest).toBe(DIGEST_A);
  });

  test('no assertion at all refuses with X_PASSKEY_STEP_UP_REQUIRED', async () => {
    const h = await harness();
    const error = await caught(async () =>
      h.stepUp.guard({ userId: USER, requestDigest: DIGEST_A, surface: SURFACE }),
    );
    expect(error?.code).toBe('X_PASSKEY_STEP_UP_REQUIRED');
    expect(error?.fix).toContain('passkeyStepUp');
    expect(await h.stepUp.isLive({ userId: USER, requestDigest: DIGEST_A })).toBe(false);
  });

  test('an assertion past its ttl refuses with X_PASSKEY_CHALLENGE_EXPIRED on an advanced clock', async () => {
    const h = await harness();
    const ceremony = await h.stepUp.options({ userId: USER, requestDigest: DIGEST_A });
    await h.stepUp.verify({ userId: USER, assertion: await h.answer(ceremony.challenge, 1) });
    expect(await h.stepUp.isLive({ userId: USER, requestDigest: DIGEST_A })).toBe(true);

    // One millisecond past ttlMs, on the injected clock — never a sleep and never a Date.now().
    h.clock.advance(TTL_MS + 1);
    const error = await caught(async () =>
      h.stepUp.guard({ userId: USER, requestDigest: DIGEST_A, surface: SURFACE }),
    );
    expect(error?.code).toBe('X_PASSKEY_CHALLENGE_EXPIRED');
    expect(await h.stepUp.isLive({ userId: USER, requestDigest: DIGEST_A })).toBe(false);
  });

  test('the evidence is the assertion, with the digest the SERVER supplied', async () => {
    const h = await harness();
    const ceremony = await h.stepUp.options({ userId: USER, requestDigest: DIGEST_A });
    expect(ceremony.requestDigest).toBe(DIGEST_A);
    // The ceremony's challenge IS the derivation of the digest, so the browser signs the request.
    expect(ceremony.challenge).toBe(DIGEST_A);
    const evidence = await h.stepUp.verify({
      userId: USER,
      assertion: await h.answer(ceremony.challenge, 1),
    });
    expect(evidence.requestDigest).toBe(DIGEST_A);
    expect(evidence.userId).toBe(USER);
    expect(evidence.expiresAt.getTime()).toBe(evidence.verifiedAt.getTime() + TTL_MS);
    // A signature and the client data are kept: the row is auditable, not merely a boolean.
    expect(evidence.signature.length).toBeGreaterThan(0);
    expect(JSON.parse(evidence.clientDataJson).challenge).toBe(DIGEST_A);
  });

  test('a second store handle finds the same evidence, with its digest and its expiry', async () => {
    const h = await harness();
    const ceremony = await h.stepUp.options({ userId: USER, requestDigest: DIGEST_A });
    const evidence = await h.stepUp.verify({
      userId: USER,
      assertion: await h.answer(ceremony.challenge, 1),
    });

    // A separate 'process': nothing but the store, addressed by the id. No challenge registry, no
    // step-up index, no `Auth` — so a row found here was found by what was persisted, not cached.
    const otherStore: Pick<PasskeyStore, 'findPasskeyAssertion'> = {
      findPasskeyAssertion: (id: string) => h.auth.adapter.findPasskeyAssertion(id),
    };
    const readBack = await otherStore.findPasskeyAssertion(evidence.id);
    expect(readBack).not.toBeNull();
    expect(readBack?.requestDigest).toBe(DIGEST_A);
    expect(readBack?.expiresAt).toEqual(evidence.expiresAt);
    expect(readBack?.signature).toBe(evidence.signature);
  });

  test('a step-up ttl of NaN is refused at construction, never accepted as never-expiring', async () => {
    const h = await harness();
    // `NaN` makes `expiresAt` an Invalid Date, and `expiresAt <= now` is false — evidence that would
    // satisfy this digest forever. Refused where it is declared, like every other bounded number.
    expect(() =>
      passkeyStepUp(h.auth, { ttlMs: Number.NaN, challenge: ({ input }) => input.requestDigest }),
    ).toThrow(/passkeyStepUp\.ttlMs/);
  });

  test('a challenge that is not a digest is refused, naming the option', async () => {
    const h = await harness();
    const stepUp = passkeyStepUp(h.auth, { ttlMs: TTL_MS, challenge: () => 'not a digest' });
    const error = await caught(async () =>
      stepUp.options({ userId: USER, requestDigest: DIGEST_A }),
    );
    expect(error?.code).toBe('X_CONFIG_INVALID');
    expect(error?.cause).toContain('passkeys: { challenge }');
  });
});
