// Single responsibility: the mail package's stable error codes and their `fix:` lines.
// Mail fails in production, not in tests — a wrong locale, an empty text part or an
// unconfigured driver must name the exact call site edit that repairs it.

import { hasErrorCode, registerErrorCodes, UltimateError } from '@ultimat3/core';

export const MAIL_ERROR_CODES = [
  'X_MAIL_LOCALE_MISSING',
  'X_MAIL_TEMPLATE_UNKNOWN',
  'X_MAIL_DUPLICATE',
  'X_MAIL_TEXT_MISSING',
  'X_MAIL_DRIVER_UNAVAILABLE',
  'X_MAIL_HEADER_INVALID',
  'X_MAIL_SEND_FAILED',
] as const;

export type MailErrorCode = (typeof MAIL_ERROR_CODES)[number];

export const MAIL_ERROR_TITLES: Readonly<Record<MailErrorCode, string>> = {
  X_MAIL_LOCALE_MISSING: 'send() was called without a locale',
  X_MAIL_TEMPLATE_UNKNOWN: 'no mail is registered under that id',
  X_MAIL_DUPLICATE: 'two mails claim the same id',
  X_MAIL_TEXT_MISSING: 'the rendered mail has no plain-text part',
  X_MAIL_DRIVER_UNAVAILABLE: 'no mail driver is configured',
  X_MAIL_HEADER_INVALID: 'a header value carries a line break',
  X_MAIL_SEND_FAILED: 'the mail transport refused the message',
};

// Titles must be registered for `format()` to render the contract's first line. The guard keeps
// the module import-order independent: registering the same code twice is X_ERROR_CODE_DUPLICATE.
for (const [code, title] of Object.entries(MAIL_ERROR_TITLES)) {
  if (!hasErrorCode(code)) registerErrorCodes({ [code]: { title } });
}

export interface MailErrorInit {
  readonly code: MailErrorCode;
  readonly cause: string;
  readonly fix: string;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
}

export class MailError extends UltimateError {
  override readonly name = 'MailError';

  constructor(init: MailErrorInit) {
    super({
      code: init.code,
      cause: init.cause,
      fix: init.fix,
      docs: `https://ultimate.dev/errors/${init.code}`,
      meta: init.meta,
    });
  }
}

export const localeMissing = (mailId: string): MailError =>
  new MailError({
    code: 'X_MAIL_LOCALE_MISSING',
    cause: `send(${mailId}, data, options) got no locale — the recipient's language is unknown`,
    fix: `pass it: send(${mailId}, data, { to, locale: ctx.locale })`,
    meta: { mailId },
  });

export const templateUnknown = (mailId: string, known: readonly string[]): MailError =>
  new MailError({
    code: 'X_MAIL_TEMPLATE_UNKNOWN',
    cause: `no mail with id "${mailId}" is registered (have: ${known.join(', ') || 'none'})`,
    fix: `x mail list --json   # then export defineMail({ id: '${mailId}', ... }) and import it`,
    meta: { mailId, known },
  });

export const layoutUnknown = (
  mailId: string,
  layout: string,
  known: readonly string[],
): MailError =>
  new MailError({
    code: 'X_MAIL_TEMPLATE_UNKNOWN',
    cause: `mail "${mailId}" wants layout "${layout}" (registered: ${known.join(', ')})`,
    fix: `registerLayout('${layout}', myLayout) at boot, or set layout: 'base' on that mail`,
    meta: { mailId, layout, known },
  });

export const mailDuplicate = (mailId: string): MailError =>
  new MailError({
    code: 'X_MAIL_DUPLICATE',
    cause: `mail id "${mailId}" is already registered by another defineMail() call`,
    fix: `x mail list --json   # then rename one of the two defineMail({ id }) declarations`,
    meta: { mailId },
  });

export const textMissing = (mailId: string): MailError =>
  new MailError({
    code: 'X_MAIL_TEXT_MISSING',
    cause: `mail "${mailId}" rendered an empty text part (HTML-only mail scores as spam)`,
    fix: `add a text block to the "${mailId}" template: blocks.paragraph('mail.${mailId}.body')`,
    meta: { mailId },
  });

export const driverUnavailable = (what: string): MailError =>
  new MailError({
    code: 'X_MAIL_DRIVER_UNAVAILABLE',
    cause: `${what} — nothing can deliver the message`,
    fix: 'setMailDriver(createMemoryDriver()) in dev, createSmtpDriver({ url: env.SMTP_URL }) live',
    meta: { what },
  });

/**
 * A CR or LF inside a header value ends the header early and lets whatever follows become new
 * headers — the recipient list, a forged `From`. Interpolated data reaches `Subject`, so this is
 * refused rather than stripped: silently rewriting a subject is its own surprise.
 */
export const headerInvalid = (name: string, mailId: string): MailError =>
  new MailError({
    code: 'X_MAIL_HEADER_INVALID',
    cause: `the "${name}" header of mail "${mailId}" contains a CR or LF, which would inject headers`,
    fix:
      `strip line breaks from the value before it reaches the header: ` +
      `t('mail.${mailId}.subject', { ...data, x: String(x).replace(/[\\r\\n]+/g, ' ') })`,
    meta: { header: name, mailId },
  });

/**
 * What a transport reports when the remote end did not take the message. `stage` names the
 * exact step of the conversation, and `status` is the provider's own number — an SMTP reply
 * code or an HTTP status — because "mail failed" without either is not a diagnosis.
 */
export interface SendFailure {
  readonly driver: string;
  /** `connect` | `greeting` | `ehlo` | `starttls` | `auth` | `from` | `recipient` | `data` | `request`. */
  readonly stage: string;
  readonly detail: string;
  /** SMTP reply code (4xx/5xx) or HTTP status. Absent when the socket never answered. */
  readonly status?: number | undefined;
  /** True for a 4xx greylist/throttle: the job's next attempt can succeed unchanged. */
  readonly retryable: boolean;
  readonly fix: string;
}

export const sendFailed = (failure: SendFailure): MailError =>
  new MailError({
    code: 'X_MAIL_SEND_FAILED',
    cause:
      `${failure.driver} refused the message at ${failure.stage}` +
      `${failure.status === undefined ? '' : ` (${failure.status})`}: ${failure.detail} — ` +
      `${failure.retryable ? 'transient, the job will retry' : 'permanent, retrying cannot help'}`,
    fix: failure.fix,
    meta: {
      driver: failure.driver,
      stage: failure.stage,
      retryable: failure.retryable,
      ...(failure.status === undefined ? {} : { status: failure.status }),
    },
  });
