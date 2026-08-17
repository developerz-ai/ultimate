// Single responsibility: environment → transport. The one place that decides which `MailDriver`
// a boot installs, so `x dev`, a worker container and any custom host all resolve it identically.
// The two production transports are useless until something constructs them from a credential;
// this is that something, and it is keyed on env rather than a config field so the same image
// deploys to every environment.

import { ConfigInvalidError, isLocal, resolveEnvironment } from '@ultimat3/core';
import { createMemoryDriver, createUnconfiguredDriver, type MailDriver } from './driver';
import { createResendDriver } from './driver-resend';
import { createSmtpDriver } from './driver-smtp';

/**
 * The MAIL keys read here, and nothing else. Named once so docs and tests cannot drift from the
 * code. `ULTIMATE_ENV`/`NODE_ENV` are deliberately absent: which deploy this is belongs to core's
 * one resolver, and restating it as a mail key would make it two settings with one meaning.
 */
export const MAIL_ENV_KEYS = ['SMTP_URL', 'RESEND_API_KEY', 'MAIL_FROM', 'MAIL_POOL_SIZE'] as const;

export type MailEnvironment = Readonly<Record<string, string | undefined>>;

export interface MailSelection {
  readonly driver: MailDriver;
  /**
   * Why this driver, in one line: the env key that selected it, or what to set to change it.
   * A boot prints it, so "which transport is this process using" is never a guess.
   */
  readonly detail: string;
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim().length === 0 ? undefined : value.trim();

/**
 * Both transports put the address in the envelope and in `From:`, so neither can be built
 * without it. Refused here rather than inside the driver: the cause names the env key that is
 * missing, which is the thing an operator can actually set.
 */
function requireFrom(env: MailEnvironment, selectedBy: string): string {
  const from = nonEmpty(env['MAIL_FROM']);
  if (from === undefined) {
    throw new ConfigInvalidError({
      cause: `${selectedBy} selects a mail transport, but MAIL_FROM is unset — no envelope sender`,
      fix: 'set MAIL_FROM="App <no-reply@yourdomain.test>" in .env.production',
      meta: { selectedBy, missing: 'MAIL_FROM' },
    });
  }
  return from;
}

/**
 * `Number('abc')` is `NaN`, and `NaN` reaches the driver as "poolSize: NaN" — an accurate but
 * useless cause, because the operator set a string in a file and the driver never saw the key.
 * Parsed at the boundary so the error names `MAIL_POOL_SIZE` instead.
 */
function poolSizeFrom(env: MailEnvironment): number | undefined {
  const raw = nonEmpty(env['MAIL_POOL_SIZE']);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ConfigInvalidError({
      cause: `MAIL_POOL_SIZE is "${raw}", which is not a whole number of connections >= 1`,
      fix: 'set MAIL_POOL_SIZE=4 in .env.production, or unset it to keep the default',
      meta: { MAIL_POOL_SIZE: raw },
    });
  }
  return parsed;
}

/**
 * A credential selects its transport. Two credentials is the one case that cannot be answered by
 * picking a winner — whichever this chose would be the one an operator did not mean half the time,
 * and mail would silently leave by the wrong path.
 *
 * NO credential is answered by the ENVIRONMENT, and it is the one decision here that is not about
 * a credential. In development and test it is the memory driver: the `/_x` panel shows what a
 * template renders in every locale and nothing escapes to a real address. Anywhere else it is a
 * driver that refuses, because the memory driver in production reports `accepted` for mail that
 * never left the process — every password reset, receipt and invitation "sent", none delivered,
 * and no error anywhere to find it by. `isLocal` is core's one reader of that question, so mail
 * cannot disagree with storage about which deploy this is.
 */
export function selectMailDriver(env: MailEnvironment): MailSelection {
  const smtpUrl = nonEmpty(env['SMTP_URL']);
  const resendKey = nonEmpty(env['RESEND_API_KEY']);

  if (smtpUrl !== undefined && resendKey !== undefined) {
    throw new ConfigInvalidError({
      cause: 'SMTP_URL and RESEND_API_KEY are both set — two transports claim the same mail',
      fix: 'unset one of them in .env.production: a process delivers through exactly one transport',
      meta: { selected: ['SMTP_URL', 'RESEND_API_KEY'] },
    });
  }

  if (smtpUrl !== undefined) {
    const poolSize = poolSizeFrom(env);
    return {
      driver: createSmtpDriver({
        url: smtpUrl,
        from: requireFrom(env, 'SMTP_URL'),
        ...(poolSize === undefined ? {} : { poolSize }),
      }),
      detail: 'SMTP_URL',
    };
  }

  if (resendKey !== undefined) {
    return {
      driver: createResendDriver({ apiKey: resendKey, from: requireFrom(env, 'RESEND_API_KEY') }),
      detail: 'RESEND_API_KEY',
    };
  }

  if (isLocal({ env })) {
    return {
      driver: createMemoryDriver(),
      detail: 'caught in memory — set SMTP_URL or RESEND_API_KEY to deliver',
    };
  }

  const environment = resolveEnvironment({ env });
  return {
    driver: createUnconfiguredDriver(environment),
    detail: `no transport configured for ${environment} — set SMTP_URL or RESEND_API_KEY`,
  };
}
