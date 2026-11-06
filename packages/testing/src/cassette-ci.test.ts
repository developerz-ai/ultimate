// A gate can never reach a vendor: recording under `CI` is refused when the cassette is built,
// before any host is let through and before any dial.

import { afterEach, expect, test } from 'bun:test';
import { CASSETTE_ENV, cassette } from './cassette';
import { tempDir, VENDOR_HOST, withEnv } from './cassette-fixture';
import { captureNetwork, requestLog, resetNetwork, sealNetwork } from './sealed-network';

sealNetwork();
afterEach(resetNetwork);

test('CI set refuses the recording before any dial, and lets no host through', async () => {
  using dir = tempDir();
  const dials = requestLog().length;
  let refusal: unknown;
  await withEnv({ [CASSETTE_ENV]: 'record', CI: 'true' }, async () => {
    try {
      await using _tape = cassette(dir.path, 'refund', { record: { hosts: [VENDOR_HOST] } });
    } catch (error) {
      refusal = error;
    }
  });
  expect(refusal).toMatchObject({ code: 'X_CASSETTE_RECORD_REFUSED' });
  expect(String((refusal as { fix?: unknown }).fix)).toStartWith('env -u CI');
  expect(requestLog().length).toBe(dials);
  expect(captureNetwork().allowed).not.toContain(VENDOR_HOST);
});

test('an unknown mode is refused rather than read as replay', async () => {
  using dir = tempDir();
  let refusal: unknown;
  await withEnv({ [CASSETTE_ENV]: 'rec' }, async () => {
    try {
      await using _tape = cassette(dir.path, 'refund');
    } catch (error) {
      refusal = error;
    }
  });
  expect(String((refusal as { cause?: unknown }).cause)).toContain(CASSETTE_ENV);
});
