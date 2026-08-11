// The auth rules a PAGE has to state and the SERVER has to enforce, declared once so the sentence
// in the form and the check behind it cannot drift. `site/` may not import `app/`, and a constant
// copied across that boundary is a constant that will be changed on one side only.
//
// The public half of the anti-bot config lives here too. The SECRET does not — it is read in
// `app/auth/captcha.ts` alone, so no `site/` page can carry it in its module graph whatever a
// later change does to `hydrate`.

import { env } from '../../../app.config';

/**
 * The hCaptcha site key, or null when this deployment runs with no anti-bot provider at all.
 *
 * `null` is what makes the demo runnable: the page renders no widget, and `app/auth/captcha.ts`
 * independently selects the null verifier from the *secret* being unset. The two halves read two
 * different variables on purpose — a site key with no secret must render nothing, because a widget
 * whose answer nobody verifies is theatre.
 */
export const captchaSiteKey = (): string | null => {
  const key = env.HCAPTCHA_SITE_KEY;
  return key === undefined || key.trim().length === 0 ? null : key;
};

/** The script the widget needs. A third-party tag, and the one thing on `site/` that is not ours. */
export const HCAPTCHA_SCRIPT_URL = 'https://js.hcaptcha.com/1/api.js';

/** How many refusals one handle gets before sign-in demands a challenge before the password check. */
export const CAPTCHA_AFTER_FAILURES = 3;

/** The field hCaptcha's widget posts. Named by the form, read by the action. */
export const CAPTCHA_FIELD = 'h-captcha-response';

/**
 * Eight. Short enough that a demo account is typable, long enough to be a rule at all.
 *
 * The two seeded logins (`user`/`user`, `admin`/`admin`) are shorter and stay valid, because they
 * are bootstrapped rather than registered — a demo whose advertised password its own sign-up form
 * rejects would be a worse lie than a short password.
 */
export const MIN_PASSWORD_LENGTH = 8;
