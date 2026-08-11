// unit — the anti-bot adapter, and every way it is allowed to say "no".
//
// The cases that matter are the failures. A captcha that verifies a good token proves nothing an
// attacker cares about; a captcha that fails OPEN when hCaptcha is slow, down, or answering with
// an error page is a signup form with no captcha on exactly the day someone is attacking it.

import { expect, unitTest } from '@ultimat3/testing';
import type { FetchLike } from './captcha';
import { HCAPTCHA_VERIFY_URL, hcaptcha, nullCaptcha } from './captcha';

const verifier = (fetchImpl: FetchLike, timeoutMs = 5000) =>
  hcaptcha({ secret: 'test-secret', fetchImpl, timeoutMs });

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

unitTest('a timeout is NOT verified — the abort is the answer, not a retry', async () => {
  // The real signal is `AbortSignal.timeout(5000)`; this stands in for a provider that never
  // answers, which is the case that decides whether the deadline exists at all.
  const hang: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  expect(await verifier(hang, 10).verify('token')).toBe(false);
});

unitTest('the request carries a deadline, so a hung provider cannot hold the request', async () => {
  let signal: AbortSignal | undefined;
  const capture: FetchLike = (_url, init) => {
    signal = init?.signal ?? undefined;
    return Promise.resolve(jsonResponse({ success: true }));
  };
  await verifier(capture).verify('token');
  expect(signal).toBeInstanceOf(AbortSignal);
});

unitTest('a non-2xx is NOT verified, whatever its body says', async () => {
  // A gateway in front of hCaptcha answers HTML, and some answer 200-shaped JSON on a 5xx. The
  // status is checked first, so neither can become a confusing second failure — or worse, a pass.
  const gateway: FetchLike = () =>
    Promise.resolve(new Response('<html>gateway</html>', { status: 502 }));
  expect(await verifier(gateway).verify('token')).toBe(false);
  const lying: FetchLike = () => Promise.resolve(jsonResponse({ success: true }, 500));
  expect(await verifier(lying).verify('token')).toBe(false);
});

unitTest('a body that is not JSON is NOT verified', async () => {
  const garbled: FetchLike = () =>
    Promise.resolve(
      new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  expect(await verifier(garbled).verify('token')).toBe(false);
});

unitTest('a network error is NOT verified', async () => {
  const refused: FetchLike = () => Promise.reject(new Error('ECONNREFUSED'));
  expect(await verifier(refused).verify('token')).toBe(false);
});

unitTest('`success: false` is NOT verified, and neither is a body without it', async () => {
  const denied: FetchLike = () => Promise.resolve(jsonResponse({ success: false }));
  expect(await verifier(denied).verify('token')).toBe(false);
  const empty: FetchLike = () => Promise.resolve(jsonResponse({}));
  expect(await verifier(empty).verify('token')).toBe(false);
});

unitTest('a missing or blank token is refused without asking hCaptcha at all', async () => {
  let called = false;
  const counted: FetchLike = () => {
    called = true;
    return Promise.resolve(jsonResponse({ success: true }));
  };
  expect(await verifier(counted).verify(null)).toBe(false);
  expect(await verifier(counted).verify('   ')).toBe(false);
  expect(called).toBe(false);
});

unitTest('only a confirmed success verifies, form-encoded to hCaptcha', async () => {
  let seen: { url: string; body: string } | undefined;
  const ok: FetchLike = (url, init) => {
    seen = { url: String(url), body: String(init?.body ?? '') };
    return Promise.resolve(jsonResponse({ success: true }));
  };
  expect(await verifier(ok).verify('token')).toBe(true);
  expect(seen?.url).toBe(HCAPTCHA_VERIFY_URL);
  // `secret` and `response`, form-encoded — the shape hCaptcha documents, and the secret goes in
  // the body rather than the URL so it never lands in an access log.
  expect(seen?.body).toBe('secret=test-secret&response=token');
});

unitTest('the null verifier is disabled, which is what makes it safe to answer yes', () => {
  const nothing = nullCaptcha();
  // `enabled: false` is the load-bearing half: the service never asks a disabled verifier to
  // prove anything, so this `true` means "no challenge was set", never "the challenge passed".
  expect(nothing.enabled).toBe(false);
  expect(nothing.name).toBe('null');
});
