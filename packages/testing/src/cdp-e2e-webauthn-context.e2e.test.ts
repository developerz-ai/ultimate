// A passkey ceremony and a second person, in a REAL browser: `addVirtualAuthenticator(tab)` answers
// `navigator.credentials.create/get` with no device (CDP's `WebAuthn` domain), and
// `newBrowserContext(session)` opens tabs that share no cookie or storage with the first profile
// (`Target.createBrowserContext`) — two signed-in people in one run.
//
//   bun test ./packages/testing/src/cdp-e2e-webauthn-context.e2e.test.ts
//
// Skips with no browser on the machine, and refuses to where `E2E_BROWSER_REQUIRED=1` promised one.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { findChrome } from '@ultimat3/scraping/cdp';
import type { E2eBrowser } from './cdp-browser';
import { E2E_BROWSER_OPEN_MS, openE2eBrowser } from './cdp-browser';
import { newBrowserContext } from './cdp-e2e-context';
import { addVirtualAuthenticator } from './cdp-e2e-webauthn';

const PAGE =
  '<!doctype html><html lang="en"><head><title>p</title></head><body><main>p</main></body></html>';

// Started in `beforeAll`, so a machine that skips the suite never opens a port it cannot close.
let server: ReturnType<typeof Bun.serve> | undefined;
// `localhost`, never the IP: an IP address is not an rp id, and `localhost` is a secure context.
const baseUrl = (): string => `http://localhost:${String(server?.port)}/`;

const noBrowser =
  (await findChrome(process.env)) === undefined && process.env['E2E_BROWSER_REQUIRED'] !== '1';

const CREATE = `navigator.credentials.create({ publicKey: {
  challenge: new Uint8Array(32),
  rp: { id: 'localhost', name: 'test' },
  user: { id: new Uint8Array([1, 2, 3]), name: 'ada', displayName: 'Ada' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
} }).then((made) => made.id)`;

const GET = `navigator.credentials.get({ publicKey: {
  challenge: new Uint8Array(32), rpId: 'localhost', userVerification: 'required',
} }).then((got) => got.id)`;

describe.skipIf(noBrowser)('a virtual authenticator and a second browser context', () => {
  let browser: E2eBrowser | undefined;

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    });
    browser = await openE2eBrowser();
  }, E2E_BROWSER_OPEN_MS);

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      server?.stop(true);
    }
  }, E2E_BROWSER_OPEN_MS);

  /** The ceremony's outcome: the credential id, or the error's name. */
  const outcome = (tab: { evaluate(script: string): Promise<unknown> }, script: string) =>
    tab.evaluate(`${script}.catch((error) => 'refused: ' + error.name)`);

  const opened = (): E2eBrowser => browser ?? expect.unreachable('no browser');

  test(
    'a passkey is created and asserted with no device, and the authenticator lists it',
    async () => {
      const tab = await opened().session.newTab();
      await tab.goto(baseUrl());
      const authenticator = await addVirtualAuthenticator(tab);
      const created = await tab.evaluate(CREATE);
      expect(typeof created).toBe('string');
      expect(await tab.evaluate(GET)).toBe(created);
      const credentials = await authenticator.credentials();
      expect(credentials.map((one) => [one.rpId, one.resident])).toEqual([['localhost', true]]);
      expect(credentials[0]?.signCount).toBeGreaterThan(0);
      // Verification off: a ceremony that requires it is refused; back on, it is answered again.
      await authenticator.setUserVerified(false);
      expect(String(await outcome(tab, GET))).toStartWith('refused: ');
      await authenticator.setUserVerified(true);
      expect(await outcome(tab, GET)).toBe(created);
      await authenticator.remove();
      let gone: unknown;
      await authenticator.credentials().catch((error: unknown) => {
        gone = error;
      });
      expect(gone).toBeDefined();
      await tab.close();
    },
    E2E_BROWSER_OPEN_MS,
  );

  test(
    'a tab in a new context shares no cookie with the first profile',
    async () => {
      const first = await opened().session.newTab();
      await first.goto(baseUrl());
      await first.evaluate(`document.cookie = 'who=ada; path=/'`);
      expect(await first.evaluate('document.cookie')).toBe('who=ada');
      const context = await newBrowserContext(opened().session);
      const second = await context.newTab();
      await second.goto(baseUrl());
      expect(await second.evaluate('document.cookie')).toBe('');
      await second.evaluate(`document.cookie = 'who=grace; path=/'`);
      expect(await second.evaluate('document.cookie')).toBe('who=grace');
      expect(await first.evaluate('document.cookie')).toBe('who=ada');
      await context.close();
      // The context's tabs went with it; the first profile's did not.
      let closed: unknown;
      await second.evaluate('1').catch((error: unknown) => {
        closed = error;
      });
      expect(closed).toBeDefined();
      expect(await first.evaluate('document.cookie')).toBe('who=ada');
      await first.close();
    },
    E2E_BROWSER_OPEN_MS,
  );
});
