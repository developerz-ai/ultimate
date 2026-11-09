// The browser half against the server half, through a host that stands in for
// `navigator.credentials`: options leave the server as JSON, become the binary dictionaries
// WebAuthn takes, the software authenticator answers, and the credential comes back as JSON the
// server verifies — so an encoding slip on either side fails here, not in a person's browser.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { defineAuth } from './auth';
import { base64Url, base64UrlBytes } from './base64url';
import { memoryAuthAdapter } from './memory-adapter';
import {
  getPasskey,
  newPasskey,
  type PasskeyClientHost,
  type PasskeyOutcome,
} from './passkey-client';
import { passkeyLogin } from './passkey-login';
import type { PasskeyAssertionResponse, PasskeyRegistrationResponse } from './passkey-wire';
import { type SoftAuthenticator, softAuthenticator } from './soft-authenticator';

const ORIGIN = 'https://example.com';
const ADA = '00000000-0000-7000-8000-000000000c01';

const text = (source: BufferSource | undefined): string =>
  source === undefined
    ? ''
    : base64Url(new Uint8Array(source instanceof ArrayBuffer ? source : source.buffer));
const buffer = (field: string | null | undefined): ArrayBuffer =>
  (base64UrlBytes(field ?? '') ?? new Uint8Array()).buffer;

/** `navigator.credentials`, played by the software authenticator, speaking the binary dictionaries. */
const hostFor = (device: SoftAuthenticator): PasskeyClientHost => ({
  async create(options) {
    const key = options.publicKey;
    if (key === undefined) return null;
    const answer: PasskeyRegistrationResponse = await device.create({
      challenge: text(key.challenge),
      rp: { id: key.rp.id ?? '', name: key.rp.name },
      user: { id: text(key.user.id), name: key.user.name, displayName: key.user.displayName },
      pubKeyCredParams: [],
      timeout: key.timeout ?? 0,
      attestation: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      excludeCredentials: [],
    });
    return {
      id: answer.id,
      type: 'public-key',
      rawId: buffer(answer.rawId),
      response: {
        clientDataJSON: buffer(answer.response.clientDataJSON),
        attestationObject: buffer(answer.response.attestationObject),
        getTransports: () => ['internal'],
      },
    } as unknown as Credential;
  },
  async get(options) {
    const key = options.publicKey;
    if (key === undefined) return null;
    const answer: PasskeyAssertionResponse = await device.get({
      challenge: text(key.challenge),
      rpId: key.rpId ?? '',
      timeout: key.timeout ?? 0,
      userVerification: 'required',
      allowCredentials: (key.allowCredentials ?? []).map((row) => ({
        type: 'public-key',
        id: text(row.id),
        transports: [],
      })),
    });
    return {
      id: answer.id,
      type: 'public-key',
      rawId: buffer(answer.rawId),
      response: {
        clientDataJSON: buffer(answer.response.clientDataJSON),
        authenticatorData: buffer(answer.response.authenticatorData),
        signature: buffer(answer.response.signature),
        userHandle: answer.response.userHandle === null ? null : buffer(answer.response.userHandle),
      },
    } as unknown as Credential;
  },
});

describe('newPasskey / getPasskey', () => {
  test('a registration and a sign-in round-trip through the browser helpers', async () => {
    const clock = frozenClock(Date.parse('2026-11-06T12:00:00.000Z'));
    const adapter = memoryAuthAdapter(clock);
    await adapter.createUser({
      id: ADA,
      email: 'ada@example.com',
      passwordHash: null,
      orgId: null,
      roles: [],
      createdAt: clock.now(),
    });
    const passkeys = passkeyLogin(
      defineAuth({ adapter, clock, passkeys: { rpId: 'example.com', origins: [ORIGIN] } }),
    );
    const host = hostFor(await softAuthenticator({ origin: ORIGIN }));

    const created = await newPasskey(await passkeys.registerOptions({ userId: ADA }), host);
    if (created.status !== 'ok')
      return expect.unreachable(`registration answered ${created.status}`);
    expect(created.response.response.transports).toEqual(['internal']);
    await passkeys.register({
      userId: ADA,
      response: JSON.parse(JSON.stringify(created.response)),
    });

    const got = await getPasskey(await passkeys.loginOptions(), host);
    if (got.status !== 'ok') return expect.unreachable(`sign-in answered ${got.status}`);
    const result = await passkeys.login({ response: JSON.parse(JSON.stringify(got.response)) });
    expect(result.actor.id).toBe(ADA);
  });

  test('no WebAuthn in this browser is unsupported, never a throw', async () => {
    const options = {
      challenge: 'AA',
      rpId: 'example.com',
      timeout: 1,
      userVerification: 'required',
      allowCredentials: [],
    } as const;
    expect(await getPasskey(options, null)).toEqual({ status: 'unsupported' });
  });

  const REFUSALS: readonly (readonly [string, PasskeyOutcome<never>])[] = [
    ['NotAllowedError', { status: 'cancelled' }],
    ['AbortError', { status: 'cancelled' }],
    ['SecurityError', { status: 'failed', error: 'SecurityError' }],
  ];
  test.each(REFUSALS)('a %s from the browser is an outcome', async (name, outcome) => {
    const refusing: PasskeyClientHost = {
      create: () => Promise.reject(Object.assign(new Error('refused'), { name })),
      get: () => Promise.reject(Object.assign(new Error('refused'), { name })),
    };
    const options = {
      challenge: 'AA',
      rpId: 'example.com',
      timeout: 1,
      userVerification: 'required',
      allowCredentials: [],
    } as const;
    expect(await getPasskey(options, refusing)).toEqual(outcome);
  });

  test('a host that answers no credential is a failure, not a crash', async () => {
    const empty: PasskeyClientHost = { create: async () => null, get: async () => null };
    const options = {
      challenge: 'AA',
      rpId: 'example.com',
      timeout: 1,
      userVerification: 'required',
      allowCredentials: [],
    } as const;
    expect(await getPasskey(options, empty)).toEqual({ status: 'failed', error: 'NoCredential' });
  });
});
