// Single responsibility: environment → transport. The one place that decides which `MailDriver`
// a boot installs, so `x dev`, a worker container and any custom host all resolve it identically.
// The two production transports are useless until something constructs them from a credential;
// this is that something, and it is keyed on env rather than a config field so the same image
// deploys to every environment.

import { ConfigInvalidError, isLocal, resolveEnvironment } from '@ultimat3/core';
import { createMemoryDriver, createUnconfiguredDriver, type MailDriver } from './driver';
import { createResendDriver } from './driver-resend';
import { createSesDriver } from './driver-ses';
import { createSmtpDriver } from './driver-smtp';
import { type RetainMimeOptions, resolveRetainMime } from './retain-mime';

/**
 * The MAIL keys read here, and nothing else. Named once so docs and tests cannot drift from the
 * code. `ULTIMATE_ENV`/`NODE_ENV` are deliberately absent: which deploy this is belongs to core's
 * one resolver, and restating it as a mail key would make it two settings with one meaning.
 */
export const MAIL_ENV_KEYS = [
  'SMTP_URL',
  'RESEND_API_KEY',
  'MAIL_FROM',
  'MAIL_POOL_SIZE',
  'SES_REGION',
  'SES_ACCESS_KEY_ID',
  'SES_SECRET_ACCESS_KEY',
  'SES_SESSION_TOKEN',
  'SES_ENDPOINT',
  'SES_CONFIGURATION_SET',
] as const;

/** The key that SELECTS each transport. More than one set at once is refused, never resolved. */
const SELECTING_KEYS = ['SMTP_URL', 'RESEND_API_KEY', 'SES_REGION'] as const;

/**
 * What a boot passes that an environment cannot: a function. `retainMime` reaches the transports
 * that build the MIME (SMTP, SES); Resend builds it on its own side, so asking for it there is
 * refused rather than silently keeping nothing.
 */
export interface MailSelectOptions {
  readonly retainMime?: RetainMimeOptions | undefined;
  /**
   * Where `retainMime` was written, named in a refusal so it points at the line to edit. Default
   * `retainMime`; `@ultimat3/cli`'s boot passes `mail.retainMime`, the `app.config.ts` key.
   */
  readonly retainMimeKey?: string | undefined;
}

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
      fix: 'MAIL_FROM="App <no-reply@yourdomain.test>" — in .env.production',
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
      fix: 'MAIL_POOL_SIZE=4 — in .env.production, or unset it to keep the default',
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
export function selectMailDriver(
  env: MailEnvironment,
  options: MailSelectOptions = {},
): MailSelection {
  // The cap first, before any branch: only SMTP and SES build a retaining transport, so a cap
  // above the ceiling booted on memory, unconfigured and Resend, and the same options refused the
  // boot the day `SMTP_URL` was set. One check, `resolveRetainMime`, the transports' own.
  resolveRetainMime('selectMailDriver', options.retainMime, options.retainMimeKey);
  const selected = SELECTING_KEYS.filter((key) => nonEmpty(env[key]) !== undefined);
  if (selected.length > 1) {
    throw new ConfigInvalidError({
      cause: `${selected.join(' and ')} are ${selected.length === 2 ? 'both' : 'all'} set — ${selected.length} transports claim the same mail`,
      fix: 'unset one of them in .env.production: a process delivers through exactly one transport',
      meta: { selected },
    });
  }

  const smtpUrl = nonEmpty(env['SMTP_URL']);
  if (smtpUrl !== undefined) {
    const poolSize = poolSizeFrom(env);
    return {
      driver: createSmtpDriver({
        url: smtpUrl,
        from: requireFrom(env, 'SMTP_URL'),
        ...(poolSize === undefined ? {} : { poolSize }),
        retainMime: options.retainMime,
      }),
      detail: 'SMTP_URL',
    };
  }

  const resendKey = nonEmpty(env['RESEND_API_KEY']);
  if (resendKey !== undefined) {
    if (options.retainMime !== undefined) throw retainOnResend();
    return {
      driver: createResendDriver({ apiKey: resendKey, from: requireFrom(env, 'RESEND_API_KEY') }),
      detail: 'RESEND_API_KEY',
    };
  }

  const sesRegion = nonEmpty(env['SES_REGION']);
  if (sesRegion !== undefined) {
    return { driver: sesFrom(env, sesRegion, options), detail: 'SES_REGION' };
  }

  if (isLocal({ env })) {
    return {
      driver: createMemoryDriver(),
      detail: 'caught in memory — set SMTP_URL, RESEND_API_KEY or SES_REGION to deliver',
    };
  }

  const environment = resolveEnvironment({ env });
  return {
    driver: createUnconfiguredDriver(environment),
    detail: `no transport configured for ${environment} — set SMTP_URL, RESEND_API_KEY or SES_REGION`,
  };
}

/** The credential pair is required by `createSesDriver`, which names whichever half is missing. */
function sesFrom(env: MailEnvironment, region: string, options: MailSelectOptions): MailDriver {
  const sessionToken = nonEmpty(env['SES_SESSION_TOKEN']);
  const endpoint = nonEmpty(env['SES_ENDPOINT']);
  const configurationSet = nonEmpty(env['SES_CONFIGURATION_SET']);
  return createSesDriver({
    region,
    credentials: {
      accessKeyId: nonEmpty(env['SES_ACCESS_KEY_ID']) ?? '',
      secretAccessKey: nonEmpty(env['SES_SECRET_ACCESS_KEY']) ?? '',
      ...(sessionToken === undefined ? {} : { sessionToken }),
    },
    from: requireFrom(env, 'SES_REGION'),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(configurationSet === undefined ? {} : { configurationSet }),
    retainMime: options.retainMime,
  });
}

function retainOnResend(): ConfigInvalidError {
  return new ConfigInvalidError({
    cause:
      'retainMime was asked for, and RESEND_API_KEY selects resend — which builds the MIME on ' +
      "Resend's side, so this process never holds the bytes it would keep",
    fix: 'selectMailDriver(env) — drop retainMime for resend, or select SMTP_URL or SES_REGION instead',
    meta: { selected: 'RESEND_API_KEY' },
  });
}
