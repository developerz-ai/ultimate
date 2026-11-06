// No secret reaches disk through a cassette: a credential-named env var's value, in a body, a URL,
// base64 and percent-encoded, is refused at dispose, the file is absent, and the error names the
// KEY and never the value — including when the app's own `redact` put the value back.

import { afterEach, describe, expect, test } from 'bun:test';
// why: whether the refused recording left a file is the assertion; Bun has no sync exists.
import { existsSync } from 'node:fs';
import type { CassetteOptions } from './cassette';
import { cassette } from './cassette';
import {
  json,
  recordEnv,
  tempDir,
  VENDOR,
  VENDOR_HOST,
  withEnv,
  withVendor,
} from './cassette-fixture';
import { findSecret, SECRET_MIN_LENGTH, secretSources } from './cassette-secret-scan';
import { resetNetwork, sealNetwork } from './sealed-network';

sealNetwork();
afterEach(resetNetwork);

const KEY = 'CASSETTE_SCAN_API_KEY';
const VALUE = 'sk_live_Zq8+/w9x=Ab';

/** Records one GET whose answer `body` builds from the secret; resolves to the dispose's verdict. */
async function recordEcho(
  url: string,
  body: Response,
  options: CassetteOptions = {},
): Promise<{ readonly refusal: unknown; readonly written: boolean }> {
  using dir = tempDir();
  let refusal: unknown;
  await withEnv({ ...recordEnv, [KEY]: VALUE }, () =>
    withVendor([[`GET ${url}`, [body]]], async () => {
      try {
        await using _tape = cassette(dir.path, 'echo', {
          ...options,
          record: { hosts: [VENDOR_HOST] },
        });
        await fetch(url);
      } catch (error) {
        refusal = error;
      }
    }),
  );
  return { refusal, written: existsSync(`${dir.path}/__cassettes__/echo.json`) };
}

const refusedWithoutValue = (verdict: { refusal: unknown; written: boolean }) => {
  expect(verdict.refusal).toMatchObject({ code: 'X_CASSETTE_SECRET', meta: { key: KEY } });
  expect(verdict.written).toBe(false);
  const text = `${String((verdict.refusal as { cause?: unknown }).cause)} ${String(
    (verdict.refusal as { fix?: unknown }).fix,
  )}`;
  expect(text).toContain(KEY);
  expect(text).not.toContain(VALUE);
};

describe('the scan refuses every encoding', () => {
  test('raw, in a body under a key the masking does not name', async () => {
    refusedWithoutValue(await recordEcho(`${VENDOR}/echo`, json({ echo: VALUE })));
  });

  test('percent-encoded, in the recorded URL', async () => {
    const url = `${VENDOR}/echo?ref=${encodeURIComponent(VALUE)}`;
    refusedWithoutValue(await recordEcho(url, json({ ok: true })));
  });

  test('base64, in a body', async () => {
    const encoded = Buffer.from(VALUE).toString('base64');
    refusedWithoutValue(await recordEcho(`${VENDOR}/echo`, json({ blob: encoded })));
  });

  test('base64url, in a text body', async () => {
    const text = `prefix-${Buffer.from(VALUE).toString('base64url')}`;
    const body = new Response(text, { headers: { 'content-type': 'text/plain' } });
    refusedWithoutValue(await recordEcho(`${VENDOR}/echo`, body));
  });

  test('raw, inside a binary body the file holds as base64', async () => {
    const bytes = new Uint8Array([0xff, 0xfe, ...new TextEncoder().encode(VALUE), 0x00]);
    const body = new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
    refusedWithoutValue(await recordEcho(`${VENDOR}/echo`, body));
  });

  test("an app's redact that puts the value back is still refused", async () => {
    const verdict = await recordEcho(`${VENDOR}/echo`, json({ ok: true }), {
      redact: (text) => `${text}${VALUE}`,
    });
    refusedWithoutValue(verdict);
  });

  test('a value the cassette is handed counts too, named by its position', async () => {
    const handed = 'whsec_handed_value_1';
    const verdict = await recordEcho(`${VENDOR}/echo`, json({ echo: handed }), {
      secrets: [handed],
    });
    expect(verdict.refusal).toMatchObject({
      code: 'X_CASSETTE_SECRET',
      meta: { key: 'secrets[0]' },
    });
    expect(verdict.written).toBe(false);
  });

  test('a clean recording is written', async () => {
    const verdict = await recordEcho(`${VENDOR}/echo`, json({ ok: true }));
    expect(verdict.refusal).toBeUndefined();
    expect(verdict.written).toBe(true);
  });
});

describe('findSecret', () => {
  test('names the key and the UTF-8 byte offset, first by position', () => {
    const sources = secretSources({ STRIPE_SECRET_KEY: 'abcdefgh12', PLAIN: 'abcdefgh12' }, []);
    expect(sources.map((source) => source.key)).toEqual(['STRIPE_SECRET_KEY']);
    expect(findSecret('€ abcdefgh12', sources)).toEqual({
      key: 'STRIPE_SECRET_KEY',
      offset: 4,
      encoding: 'raw',
    });
  });

  test(`a value under ${SECRET_MIN_LENGTH} characters is skipped, as stated`, () => {
    expect(secretSources({ API_KEY: 'short' }, ['tiny'])).toEqual([]);
  });
});
