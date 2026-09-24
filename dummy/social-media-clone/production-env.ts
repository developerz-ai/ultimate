// The environment rules that depend on WHICH environment this is — the one thing `defineEnv`'s
// schema cannot say (it has `required` and `role`, no per-environment form). Run once, at boot,
// from `app.config.ts`, so a production pod with a missing origin never binds a listener.

import { type Environment, EnvMissingError } from '@ultimat3/core';

/** The keys this file judges, as `defineEnv` hands them over: absent when unset. */
export interface ProductionEnvValues {
  readonly APP_URL?: string | undefined;
  readonly HCAPTCHA_SECRET?: string | undefined;
}

/** The one method this file needs from a logger, so a test can hand it a recorder. */
export interface BootWarnings {
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

/**
 * Set means non-blank: an empty secret mount is not a value. Exported because `captcha.ts` selects
 * its verifier on the same answer, and two spellings of "unset" would let the warning and the
 * verifier disagree about one key.
 */
export const isSet = (value: string | undefined): value is string =>
  value !== undefined && value.trim().length > 0;

/**
 * Production refuses a missing `APP_URL`; everywhere else leaves it optional, because `x dev` and
 * the tests have no public origin to give. It had a `http://localhost:3000` default that production
 * accepted in silence, so every absolute URL the deployed demo built named the pod's own loopback.
 *
 * `HCAPTCHA_SECRET` unset selects the null verifier (`apps/web/app/auth/captcha.ts`). That is the
 * design locally and a gap anywhere else, but it is a WARNING and not a refusal: the deployed demo
 * has no sealed hCaptcha key yet, and a required key would crash-loop it. Refusing it is a one-line
 * change once the key exists.
 */
export function checkProductionEnv(
  values: ProductionEnvValues,
  environment: Environment,
  log: BootWarnings,
): void {
  if (environment === 'production' && !isSet(values.APP_URL)) {
    throw new EnvMissingError({
      cause: 'APP_URL is unset in production — every absolute URL this app builds needs its origin',
      fix: 'export APP_URL=https://<your public host>   # the origin browsers reach this app at',
      meta: { key: 'APP_URL', environment },
    });
  }
  const local = environment === 'development' || environment === 'test';
  if (!(local || isSet(values.HCAPTCHA_SECRET))) {
    log.warn('auth.captcha.unverified', {
      environment,
      key: 'HCAPTCHA_SECRET',
      verifier: 'null',
      fix: 'set HCAPTCHA_SECRET (and HCAPTCHA_SITE_KEY) so sign-up and sign-in demand a challenge',
    });
  }
}
