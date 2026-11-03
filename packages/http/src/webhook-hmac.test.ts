// `verifyBodyHmac`: a vendor's hmac over the exact bytes, in either encoding, behind an optional
// prefix, under any of the rotation secrets — and refused for one flipped byte or an empty secret.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { verifyBodyHmac } from './webhook-hmac';

const BODY = new TextEncoder().encode('{"id":"evt_1","type":"invoice.paid"}');
const SECRET = 'whsec_current';
const OLD = 'whsec_previous';

const mac = (secret: string, bytes: Uint8Array, encoding: 'hex' | 'base64'): string =>
  new Bun.CryptoHasher('sha256', secret).update(bytes).digest(encoding);

/** The refusal's code, or the verdict that nothing was refused. */
const refusal = (run: () => void): string => {
  try {
    run();
    return 'accepted';
  } catch (error) {
    return isUltimateError(error) ? error.code : 'uncoded';
  }
};

describe('verifyBodyHmac', () => {
  test('a hex mac over the exact bytes verifies', () => {
    const given = mac(SECRET, BODY, 'hex');
    expect(
      refusal(() => verifyBodyHmac({ bytes: BODY, secret: SECRET, given, encoding: 'hex' })),
    ).toBe('accepted');
  });

  test('it answers the verified bytes and their text, so an id is read from signed data', () => {
    const given = mac(SECRET, BODY, 'hex');
    const verified = verifyBodyHmac({ bytes: BODY, secret: SECRET, given, encoding: 'hex' });
    expect(verified.bytes).toBe(BODY);
    expect(verified.text).toBe(new TextDecoder().decode(BODY));
    const binary = new Uint8Array([0xff, 0x00]);
    expect(
      verifyBodyHmac({
        bytes: binary,
        secret: SECRET,
        given: mac(SECRET, binary, 'hex'),
        encoding: 'hex',
      }).text,
    ).toBeNull();
  });

  test('a base64 mac verifies, and the same mac read as hex does not', () => {
    const given = mac(SECRET, BODY, 'base64');
    expect(
      refusal(() => verifyBodyHmac({ bytes: BODY, secret: SECRET, given, encoding: 'base64' })),
    ).toBe('accepted');
    expect(
      refusal(() => verifyBodyHmac({ bytes: BODY, secret: SECRET, given, encoding: 'hex' })),
    ).toBe('X_WEBHOOK_SIGNATURE_INVALID');
  });

  test('the prefix is part of what is compared', () => {
    const given = `sha256=${mac(SECRET, BODY, 'hex')}`;
    const check = (prefix?: string) => () =>
      verifyBodyHmac({
        bytes: BODY,
        secret: SECRET,
        given,
        encoding: 'hex',
        ...(prefix === undefined ? {} : { prefix }),
      });
    expect(refusal(check('sha256='))).toBe('accepted');
    expect(refusal(check())).toBe('X_WEBHOOK_SIGNATURE_INVALID');
    expect(refusal(check('sha1='))).toBe('X_WEBHOOK_SIGNATURE_INVALID');
  });

  test('a mac under the second rotation secret verifies; one under neither does not', () => {
    const old = mac(OLD, BODY, 'hex');
    expect(
      refusal(() =>
        verifyBodyHmac({ bytes: BODY, secret: [SECRET, OLD], given: old, encoding: 'hex' }),
      ),
    ).toBe('accepted');
    expect(
      refusal(() =>
        verifyBodyHmac({
          bytes: BODY,
          secret: [SECRET, OLD],
          given: mac('whsec_other', BODY, 'hex'),
          encoding: 'hex',
        }),
      ),
    ).toBe('X_WEBHOOK_SIGNATURE_INVALID');
  });

  test('one flipped byte of the body fails', () => {
    const given = mac(SECRET, BODY, 'hex');
    const flipped = new Uint8Array(BODY);
    flipped[3] = (flipped[3] ?? 0) ^ 0x01;
    expect(
      refusal(() => verifyBodyHmac({ bytes: flipped, secret: SECRET, given, encoding: 'hex' })),
    ).toBe('X_WEBHOOK_SIGNATURE_INVALID');
  });

  test('a text body is the same as its UTF-8 bytes', () => {
    const text = 'café ✓';
    const given = mac(SECRET, new TextEncoder().encode(text), 'hex');
    expect(
      refusal(() => verifyBodyHmac({ bytes: text, secret: SECRET, given, encoding: 'hex' })),
    ).toBe('accepted');
  });

  test('no signature given is refused as a signature, not accepted as empty', () => {
    for (const given of [null, undefined, '']) {
      expect(
        refusal(() => verifyBodyHmac({ bytes: BODY, secret: SECRET, given, encoding: 'hex' })),
      ).toBe('X_WEBHOOK_SIGNATURE_INVALID');
    }
  });

  test('an empty secret, an empty list or an unset env var is X_CONFIG_INVALID', () => {
    const given = mac('', BODY, 'hex');
    for (const secret of ['', [], [SECRET, ''], undefined]) {
      expect(
        refusal(() =>
          verifyBodyHmac({
            bytes: BODY,
            secret: secret as unknown as string,
            given,
            encoding: 'hex',
          }),
        ),
      ).toBe('X_CONFIG_INVALID');
    }
  });

  test('neither the secret nor the given mac reaches the refusal', () => {
    const given = mac('whsec_other', BODY, 'hex');
    try {
      verifyBodyHmac({ bytes: BODY, secret: SECRET, given, encoding: 'hex' });
      expect.unreachable('a mac under another secret verified');
    } catch (error) {
      const text = JSON.stringify(isUltimateError(error) ? error.toJSON() : null);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(given);
    }
  });
});
