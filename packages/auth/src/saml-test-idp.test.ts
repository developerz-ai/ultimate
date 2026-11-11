// The test IdP's own numeric option: a `lifetimeMs` that is not a number is refused with a code,
// never rendered as an `Invalid time value` from deep inside the assertion's timestamps.

import { describe, expect, test } from 'bun:test';
import { samlTestIdp } from './saml-test-idp';

const spec = {
  requestId: 'req-1',
  acsUrl: 'https://sp.example.test/acs',
  audience: 'https://sp.example.test',
  now: new Date('2026-11-10T09:00:00.000Z'),
};

describe('samlTestIdp lifetimeMs', () => {
  test('a non-finite lifetime is a coded refusal', async () => {
    const idp = await samlTestIdp();
    for (const lifetimeMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(idp.responseXml({ ...spec, lifetimeMs })).rejects.toThrow(
        expect.objectContaining({ code: 'X_INVARIANT' }),
      );
    }
  });

  test('a negative lifetime is an already-expired assertion, not a refusal', async () => {
    const idp = await samlTestIdp();
    const xml = await idp.responseXml({ ...spec, lifetimeMs: -60_000 });
    expect(xml).toContain('NotOnOrAfter="2026-11-10T08:59:00Z"');
  });
});
