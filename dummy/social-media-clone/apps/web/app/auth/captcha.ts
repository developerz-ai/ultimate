// Anti-bot verification: the seam, the hCaptcha adapter, the null adapter, and the one place that
// picks between them. The framework ships no captcha primitive and must not grow one — this is an
// app concern, and a second provider arrives as a second adapter, never as a branch in here.

import { env } from '../../../../app.config';

/**
 * What the auth service depends on. Deliberately narrower than any provider's API: a boolean is
 * the whole answer, so no call site can start reading a score, a hostname or an error list and
 * quietly couple itself to hCaptcha.
 */
export interface CaptchaVerifier {
  /** Reported in `X_AUTH_CAPTCHA_FAILED`, so a refusal names which verifier refused. */
  readonly name: string;
  /** `false` means this deployment demands no challenge at all — the local, keyless demo. */
  readonly enabled: boolean;
  /** Fails CLOSED: anything that is not a confirmed success is `false`. */
  verify(token: string | null): Promise<boolean>;
}

/**
 * No keys, no challenge. This is what makes `x dev` a runnable demo: a signup form that cannot be
 * submitted without a credential nobody in the clone has is a demo nobody can run.
 *
 * It answers `true`, and that is safe ONLY because `enabled` is false — the service never asks a
 * disabled verifier to prove anything, so this is "no challenge was set", not "the challenge passed".
 */
export const nullCaptcha = (): CaptchaVerifier => ({
  name: 'null',
  enabled: false,
  verify: () => Promise.resolve(true),
});

export const HCAPTCHA_VERIFY_URL = 'https://api.hcaptcha.com/siteverify';

/** Five seconds. A sign-in that hangs on a third party is an outage the third party gets to cause. */
export const CAPTCHA_TIMEOUT_MS = 5000;

/**
 * Exactly the shape this adapter calls, and no wider. `typeof fetch` would drag in Bun's
 * `fetch.preconnect`, which every stub in a test would then have to grow for no reason — a type
 * that forces a fake to imitate an API nobody calls is a type that makes tests worse.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HcaptchaOptions {
  /** Server-only. Never reaches a template, a log line or the browser. */
  readonly secret: string;
  /** Injected so a test can drive every failure mode without a network the harness has sealed. */
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

/** hCaptcha answers `{ "success": true|false, ... }`; nothing else in that body is load-bearing. */
const succeeded = (body: unknown): boolean =>
  typeof body === 'object' && body !== null && (body as { success?: unknown }).success === true;

/**
 * The hCaptcha adapter. Server-side verification is the only verification there is — the widget in
 * the browser proves nothing, because the caller controls the browser.
 */
export const hcaptcha = (options: HcaptchaOptions): CaptchaVerifier => {
  const call: FetchLike = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? CAPTCHA_TIMEOUT_MS;
  return {
    name: 'hcaptcha',
    enabled: true,
    async verify(token: string | null): Promise<boolean> {
      if (token === null || token.trim().length === 0) return false;
      try {
        const response = await call(HCAPTCHA_VERIFY_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ secret: options.secret, response: token }).toString(),
          // The deadline is on the REQUEST, not on a race after it: an abort releases the socket,
          // where a `Promise.race` would leave the connection open and the process waiting on it.
          signal: AbortSignal.timeout(timeoutMs),
        });
        // Fail closed on the status BEFORE the body: a 500 from hCaptcha carrying an HTML error
        // page must never reach the JSON parse and become a confusing second failure.
        if (!response.ok) return false;
        return succeeded(await response.json());
      } catch {
        // Everything that is not a confirmed success lands here: DNS, TLS, a refused connection,
        // the abort above, and a body that would not parse. There is no branch, because there is
        // no outcome among them that means "verified".
        return false;
      }
    },
  };
};

/**
 * The composition root, and the only place that reads the secret. Memoized: the choice is made
 * from the environment at boot and cannot change per request, so re-deciding it per call would be
 * an invitation to make it configurable per caller — which is how two auth paths start.
 */
let selected: CaptchaVerifier | undefined;

export const captcha = (): CaptchaVerifier => {
  selected ??=
    env.HCAPTCHA_SECRET === undefined || env.HCAPTCHA_SECRET.trim().length === 0
      ? nullCaptcha()
      : hcaptcha({ secret: env.HCAPTCHA_SECRET });
  return selected;
};

/** Test seam. Production selects once at boot and never re-selects. */
export const useCaptcha = (verifier: CaptchaVerifier | undefined): void => {
  selected = verifier;
};
