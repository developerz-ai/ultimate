/**
 * unit — Postly's approver key registry (`./confirmations-keys.ts`): a signature verifies only under
 * a key registered to the approver who sent it, over the exact payload, and a registry that is not
 * the declared shape refuses rather than reading as "nobody may approve".
 */

import { expect, test } from 'bun:test';
import type { McpEvidenceCheck } from '@ultimat3/mcp';
import { APPROVER_KEYS_ENV, approverKeys, verifyApproverSignature } from './confirmations-keys';

const b64url = (bytes: ArrayBuffer): string =>
  new Uint8Array(bytes).toBase64({ alphabet: 'base64url', omitPadding: true });

const device = async () => {
  const key = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return {
    publicKey: b64url(await crypto.subtle.exportKey('raw', key.publicKey)),
    sign: async (payload: string) =>
      b64url(
        await crypto.subtle.sign('Ed25519', key.privateKey, new TextEncoder().encode(payload)),
      ),
  };
};

const check = (over: Partial<McpEvidenceCheck>): McpEvidenceCheck => ({
  approver: 'm-ada',
  confirmation: '0190a6d4-1111-7aaa-8bbb-000000000001',
  tool: 'publishPost',
  digest: 'h1:abcd1234:00',
  payload: '{"confirmation":"one"}',
  signature: '',
  from: ['role:owner'],
  ...over,
});

test('a signature verifies under any key registered to its approver, and only theirs', async () => {
  const [old, current, other] = [await device(), await device(), await device()];
  const before = Bun.env[APPROVER_KEYS_ENV];
  Bun.env[APPROVER_KEYS_ENV] = JSON.stringify({
    'm-ada': [old.publicKey, current.publicKey],
    'm-bruno': [other.publicKey],
  });
  try {
    const payload = check({}).payload;
    expect(await verifyApproverSignature(check({ signature: await current.sign(payload) }))).toBe(
      true,
    );
    // A rotation keeps the old key valid until it is removed from the registry.
    expect(await verifyApproverSignature(check({ signature: await old.sign(payload) }))).toBe(true);
    // Bruno's key signing as Ada, Ada's signature over another payload, garbage: none verify.
    expect(await verifyApproverSignature(check({ signature: await other.sign(payload) }))).toBe(
      false,
    );
    expect(
      await verifyApproverSignature(check({ signature: await current.sign(`${payload} `) })),
    ).toBe(false);
    expect(await verifyApproverSignature(check({ signature: '%%%' }))).toBe(false);
    expect(
      await verifyApproverSignature(
        check({ approver: 'm-kenji', signature: await current.sign(payload) }),
      ),
    ).toBe(false);
  } finally {
    if (before === undefined) delete Bun.env[APPROVER_KEYS_ENV];
    else Bun.env[APPROVER_KEYS_ENV] = before;
  }
});

test('an unset registry registers nobody; a malformed one refuses with a code', () => {
  expect(approverKeys('m-ada', {})).toEqual([]);
  for (const raw of ['not json', '{"m-ada":"one-key-not-a-list"}', '[]']) {
    expect(() => approverKeys('m-ada', { [APPROVER_KEYS_ENV]: raw })).toThrow(
      expect.objectContaining({ code: expect.stringMatching(/^X_[A-Z_]+$/) }),
    );
  }
});
