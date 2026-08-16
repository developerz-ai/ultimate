// Single responsibility: the mail package's stable error codes and their `fix:` lines.
// Mail fails in production, not in tests — a wrong locale, an empty text part or an
// unconfigured driver must name the exact call site edit that repairs it.

import { registerErrorCodes, UltimateError } from '@ultimat3/core';

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

// Titles must be registered for `format()` to render the contract's first line. Every code above is
// owned here and none is borrowed, so the call is unconditional: a second package claiming one has
// to fail as X_ERROR_CODE_DUPLICATE, not quietly keep whichever title was registered first.
registerErrorCodes(
  Object.fromEntries(Object.entries(MAIL_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

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
    fix: `export defineMail({ id: '${mailId}', ... }) and import that module at boot — the import IS the registration`,
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
    fix: `rename one of the two defineMail({ id: '${mailId}' }) declarations — an id is the key both surfaces address a template by`,
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
 * Every step a send can die at. A closed union rather than a `string`: the stage is keyed on by
 * the transports' `fix` tables and asserted on in tests, so a typo has to be a compile error
 * instead of an unmapped fix line nobody notices until it reaches an operator.
 */
export type SendStage =
  // The SMTP conversation, in the order it happens. `tls` is the implicit handshake `smtps://`
  // opens with, before any SMTP byte; `starttls` is the in-band upgrade of a plaintext connection.
  | 'connect'
  | 'tls'
  | 'greeting'
  | 'ehlo'
  | 'starttls'
  | 'auth'
  | 'from'
  | 'recipient'
  | 'data'
  | 'quit'
  // Reply framing, which can break at any of the steps above: bytes that never complete a reply.
  | 'reply'
  // The HTTPS transports: one request, so one stage.
  | 'request';

/**
 * What a transport reports when the remote end did not take the message. `stage` names the
 * exact step of the conversation, and `status` is the provider's own number — an SMTP reply
 * code or an HTTP status — because "mail failed" without either is not a diagnosis.
 */
export interface SendFailure {
  readonly driver: 'smtp' | 'resend';
  readonly stage: SendStage;
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
