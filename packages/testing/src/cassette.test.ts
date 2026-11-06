// A cassette round trip: recorded against a stand-in vendor, replayed with the network sealed and
// the vendor gone — same answers, same order — and the two ways a replay refuses (missing, unused).

import { afterEach, describe, expect, test } from 'bun:test';
// why: the written file is read back to assert what reached disk; Bun has no sync read.
import { existsSync, readFileSync } from 'node:fs';
import { cassette } from './cassette';
import {
  json,
  recordEnv,
  replayEnv,
  tempDir,
  VENDOR,
  VENDOR_HOST,
  withEnv,
  withVendor,
} from './cassette-fixture';
import { requestLog, resetNetwork, sealNetwork } from './sealed-network';

sealNetwork();
afterEach(resetNetwork);

/** The code under test: a refund call that retries once on a 503. */
async function refund(): Promise<{ status: number; body: unknown }> {
  let response = await fetch(`${VENDOR}/v1/refunds?api_key=sk_test_9f8e7d6c5b&order=7`, {
    method: 'POST',
  });
  if (response.status === 503) {
    response = await fetch(`${VENDOR}/v1/refunds?api_key=sk_test_9f8e7d6c5b&order=7`, {
      method: 'POST',
    });
  }
  return { status: response.status, body: await response.json() };
}

const rejected = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return expect.unreachable('the call was expected to refuse');
};

/** Record mode with no `record.hosts`: the cassette has nothing it may let through. */
async function recordRefund(dir: string): Promise<void> {
  await withEnv(recordEnv, async () => {
    await using _tape = cassette(dir, 'refund');
    await refund();
  });
}

describe('cassette — record, then replay', () => {
  test('a 503-then-200 retry survives the round trip, with the network sealed', async () => {
    using dir = tempDir();
    await withEnv(recordEnv, () =>
      withVendor(
        [
          [
            `POST ${VENDOR}/v1/refunds?api_key=sk_test_9f8e7d6c5b&order=7`,
            [
              json({ error: 'busy' }, 503, { 'retry-after': '1', 'set-cookie': 'sid=abc' }),
              json({ id: 're_1', amount: 500, client_secret: 'cs_live_0000' }),
            ],
          ],
        ],
        async () => {
          await using _tape = cassette(dir.path, 'refund', { record: { hosts: [VENDOR_HOST] } });
          expect((await refund()).status).toBe(200);
        },
      ),
    );
    const written = readFileSync(`${dir.path}/__cassettes__/refund.json`, 'utf8');
    // Allow-listed headers only; a credential-named key masked in the body AND the query.
    expect(written).toContain('"retry-after": "1"');
    expect(written).not.toContain('set-cookie');
    expect(written).not.toContain('cs_live_0000');
    expect(written).not.toContain('sk_test_9f8e7d6c5b');
    expect(written).toContain('api_key=%5Bredacted%5D&order=7');

    // Replay: the vendor is gone, so only the file can answer — and the real key still matches.
    await withEnv(replayEnv, async () => {
      await using tape = cassette(dir.path, 'refund');
      expect(tape.mode).toBe('replay');
      expect(await refund()).toEqual({
        status: 200,
        body: { id: 're_1', amount: 500, client_secret: '[redacted]' },
      });
      const sealed = await rejected(() => fetch(`${VENDOR}/v1/other`));
      expect(sealed).toMatchObject({ code: 'X_TEST_NETWORK_SEALED' });
    });
  });

  test('a recording with no record.hosts is refused, and nothing is written', async () => {
    using dir = tempDir();
    const refusal = await rejected(() => recordRefund(dir.path));
    expect(refusal).toMatchObject({ code: 'X_CASSETTE_RECORD_REFUSED' });
    expect(existsSync(`${dir.path}/__cassettes__/refund.json`)).toBe(false);
  });

  test('a host outside record.hosts is refused as the cassette, naming the host', async () => {
    using dir = tempDir();
    const refusal = await withEnv(recordEnv, () =>
      rejected(async () => {
        await using _tape = cassette(dir.path, 'other', { record: { hosts: [VENDOR_HOST] } });
        await fetch('https://elsewhere.test/x');
      }),
    );
    expect(refusal).toMatchObject({ code: 'X_CASSETTE_RECORD_REFUSED' });
    expect(String((refusal as { cause?: unknown }).cause)).toContain('elsewhere.test');
  });
});

describe('cassette — replay refusals', () => {
  test('no file is X_CASSETTE_MISSING, before any dial', async () => {
    using dir = tempDir();
    const dials = requestLog().length;
    const refusal = await withEnv(replayEnv, () =>
      rejected(async () => {
        await using _tape = cassette(dir.path, 'never-recorded');
      }),
    );
    expect(refusal).toMatchObject({ code: 'X_CASSETTE_MISSING' });
    expect(requestLog().length).toBe(dials);
  });

  test('an entry the run never asks for is X_CASSETTE_UNUSED at dispose', async () => {
    using dir = tempDir();
    await withEnv(recordEnv, () =>
      withVendor(
        [
          [`GET ${VENDOR}/a`, [json({ n: 1 })]],
          [`GET ${VENDOR}/b`, [json({ n: 2 })]],
        ],
        async () => {
          await using _tape = cassette(dir.path, 'two', { record: { hosts: [VENDOR_HOST] } });
          await fetch(`${VENDOR}/a`);
          await fetch(`${VENDOR}/b`);
        },
      ),
    );
    const refusal = await withEnv(replayEnv, () =>
      rejected(async () => {
        await using _tape = cassette(dir.path, 'two');
        expect(await (await fetch(`${VENDOR}/a`)).json()).toEqual({ n: 1 });
      }),
    );
    expect(refusal).toMatchObject({
      code: 'X_CASSETTE_UNUSED',
      meta: { unused: [{ method: 'GET', url: `${VENDOR}/b`, index: 0 }] },
    });
    // The cassette's routes went with it: the URL is sealed again.
    const after = await rejected(() => fetch(`${VENDOR}/a`));
    expect(after).toMatchObject({ code: 'X_TEST_NETWORK_SEALED' });
  });
});
