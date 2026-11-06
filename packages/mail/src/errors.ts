// Single responsibility: the mail package's stable error codes and their `fix:` lines.
// Mail fails in production, not in tests — a wrong locale, an empty text part or an
// unconfigured driver must name the exact call site edit that repairs it.

import {
  type Environment,
  type ErrorRetry,
  registerErrorCodes,
  registerErrorRetry,
  renderFixShellArg,
  UltimateError,
} from '@ultimat3/core';
import type { TranslationMiss } from '@ultimat3/i18n';

export const MAIL_ERROR_CODES = [
  'X_MAIL_LOCALE_MISSING',
  'X_MAIL_TEMPLATE_UNKNOWN',
  'X_MAIL_DUPLICATE',
  'X_MAIL_TEXT_MISSING',
  'X_MAIL_DRIVER_UNAVAILABLE',
  'X_MAIL_CREDENTIAL_MISSING',
  'X_MAIL_HEADER_INVALID',
  'X_MAIL_ADDRESS_INVALID',
  'X_MAIL_SEND_FAILED',
  'X_MAIL_TRANSFORM_FAILED',
  'X_MAIL_EVENT_UNVERIFIED',
  'X_MAIL_EVENT_INVALID',
  'X_MAIL_EVENT_PROVIDER_UNREACHABLE',
  'X_MAIL_KEY_MISSING',
  'X_MAIL_PREVIEW_INVALID',
  'X_MAIL_PREVIEW_MISSING',
] as const;

export type MailErrorCode = (typeof MAIL_ERROR_CODES)[number];

export const MAIL_ERROR_TITLES: Readonly<Record<MailErrorCode, string>> = {
  X_MAIL_LOCALE_MISSING: 'send() was called without a locale',
  X_MAIL_TEMPLATE_UNKNOWN: 'no mail is registered under that id',
  X_MAIL_DUPLICATE: 'two mails claim the same id',
  X_MAIL_TEXT_MISSING: 'the rendered mail has no plain-text part',
  X_MAIL_DRIVER_UNAVAILABLE: 'no mail driver is configured',
  X_MAIL_CREDENTIAL_MISSING: 'this deployment configured no mail transport',
  X_MAIL_HEADER_INVALID: 'a header value carries a line break',
  X_MAIL_ADDRESS_INVALID: 'an envelope address could restructure the SMTP command line',
  X_MAIL_SEND_FAILED: 'the mail transport refused the message',
  X_MAIL_TRANSFORM_FAILED: 'the app mail transform threw or returned no message',
  X_MAIL_EVENT_UNVERIFIED: 'a delivery notification is not signed by its provider',
  X_MAIL_EVENT_INVALID: 'a delivery notification is not a shape this receiver reads',
  X_MAIL_EVENT_PROVIDER_UNREACHABLE: 'an SNS endpoint the receiver needed did not answer',
  X_MAIL_KEY_MISSING: 'a mail rendered a key or slot with no value in its locale',
  X_MAIL_PREVIEW_INVALID: "a mail's declared preview fails its own input schema",
  X_MAIL_PREVIEW_MISSING: 'this mail declares no preview',
};

// Titles must be registered for `format()` to render the contract's first line. Every code above is
// owned here and none is borrowed, so the call is unconditional: a second package claiming one has
// to fail as X_ERROR_CODE_DUPLICATE, not quietly keep whichever title was registered first.
registerErrorCodes(
  Object.fromEntries(Object.entries(MAIL_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

/**
 * The one code in this package a queue may retry, plus the one refused content fault listed so a
 * job around `send()` dead-letters it: no retry can translate a catalog. Registered rather than
 * merely written down: `classifyThrown` reads a per-instance `terminal` only for a code somebody REGISTERED, so a
 * table with no `registerErrorRetry` call behind it lets `sendMailJob` spend all five attempts on
 * a 401 or a 550 hard bounce — the `cause` saying "permanent, retrying cannot help" while the
 * worker retries it four more times.
 *
 * `retryable` is the table entry because a transport that cannot say is a transport that timed out;
 * the permanent half arrives as the per-instance override `sendFailed` passes below, the shape
 * `@ultimat3/scraping` uses for `X_SCRAPE_HTTP_FAILED`. Every other code here is a wiring or
 * content fault that fails identically forever, and takes core's `terminal` default.
 */
export const MAIL_ERROR_RETRY = {
  X_MAIL_SEND_FAILED: 'retryable',
  X_MAIL_KEY_MISSING: 'terminal',
} as const satisfies Readonly<Partial<Record<MailErrorCode, ErrorRetry>>>;

registerErrorRetry(MAIL_ERROR_RETRY);

export interface MailErrorInit {
  readonly code: MailErrorCode;
  readonly cause: string;
  readonly fix: string;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
  /**
   * Per-instance override of the table above, for the one code that is genuinely both: a 421
   * greylist and a 550 hard bounce are the same code, and only the transport that saw the reply
   * knows which one it was.
   */
  readonly retry?: ErrorRetry | undefined;
}

export class MailError extends UltimateError {
  override readonly name = 'MailError';

  // No `docs:`. `UltimateError` fills it from `describeErrorCode(code).docs`, which is
  // `@ultimat3/core`'s `ERROR_DOCS_URL` — one page for every code, never one per code, because
  // `wiki/` is the framework's only public documentation surface and a code lives there in a TABLE
  // ROW, which has no anchor. The `https://ultimate.dev/errors/<code>` link this class built until
  // 9.x answered 404, host included, on every error mail has ever thrown.
  constructor(init: MailErrorInit) {
    super({
      code: init.code,
      cause: init.cause,
      fix: init.fix,
      meta: init.meta,
      ...(init.retry === undefined ? {} : { retry: init.retry }),
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

/**
 * A layout name claimed twice. Same code as a duplicate mail id, because it is the same failure —
 * a name this package addresses something by, taken by two declarations — and the cause names
 * which of the two spellings the reader is looking at.
 *
 * `layouts.set(name, layout)` used to answer whichever registration ran LAST: a package
 * registering `base` silently re-shelled every framework mail with nothing reported anywhere.
 */
export const mailLayoutDuplicate = (name: string): MailError =>
  new MailError({
    code: 'X_MAIL_DUPLICATE',
    cause: `mail layout "${name}" is already registered, so a second registerLayout() would replace it`,
    fix: `pick a name of your own: registerLayout('${name}-custom', myLayout) — a layout name is the key defineMail({ layout }) addresses a shell by`,
    meta: { layout: name },
  });

export const textMissing = (mailId: string): MailError =>
  new MailError({
    code: 'X_MAIL_TEXT_MISSING',
    cause: `mail "${mailId}" rendered an empty text part (HTML-only mail scores as spam)`,
    fix: `add a text block to the "${mailId}" template: blocks.paragraph('mail.${mailId}.body')`,
    meta: { mailId },
  });

/**
 * `send()` rendered a key or a slot with no value, so nothing left. Two repairs, one code: a key is
 * a catalog edit, a slot is the call site's. A framework mail's keys live in `mail/src/catalog.ts`,
 * not in the app's `en` catalog, so `x i18n sync` may seed none of them, and the fix names the file
 * to add them to. Key names are template constants: no value from `data` reaches this text.
 */
export const mailKeyMissing = (
  mailId: string,
  locale: string,
  misses: readonly TranslationMiss[],
): MailError => {
  const keys = misses.filter((miss) => miss.slot === undefined).map((miss) => miss.key);
  const slots = misses.flatMap((miss) =>
    miss.slot === undefined ? [] : [`${miss.key}{${miss.slot}}`],
  );
  const [firstSlot] = misses.filter((miss) => miss.slot !== undefined);
  // A request can carry the locale, and a fix is pasted from its first character.
  const shownLocale = renderFixShellArg(locale, '<locale>');
  return new MailError({
    code: 'X_MAIL_KEY_MISSING',
    cause: `mail "${mailId}" has no value in locale "${locale}" for ${[...keys, ...slots].join(', ')}, so it was not sent — its reader would have seen the raw ⟦key⟧`,
    fix:
      keys.length > 0 || firstSlot === undefined
        ? `x i18n sync ${shownLocale}   # then translate these in packages/i18n/catalogs/${shownLocale}.json, adding any it did not seed: ${keys.join(', ')}`
        : `blocks.paragraph('${firstSlot.key}', { ${firstSlot.slot}: value })   # pass every slot of ${slots.join(', ')} from the "${mailId}" template; a subject reads the input's top-level fields`,
    meta: { mailId, locale, keys, slots },
  });
};

export const driverUnavailable = (what: string): MailError =>
  new MailError({
    code: 'X_MAIL_DRIVER_UNAVAILABLE',
    cause: `${what} — nothing can deliver the message`,
    fix: 'setMailDriver(memoryMailDriver()) in dev, smtpMailDriver({ url: env.SMTP_URL }) live',
    meta: { what },
  });

/**
 * A DEPLOYMENT set neither credential, where `X_MAIL_DRIVER_UNAVAILABLE` is a WIRING bug — one is
 * fixed by an operator setting a variable, the other by a developer calling `setMailDriver`, so
 * they are two codes and not one cause string.
 *
 * Raised on the send rather than at boot, deliberately: a boot refusal turns a working deploy of an
 * app that sends no mail into a failing one, while this lands on the exact path that needed the
 * capability — the alternative being the memory driver reporting `accepted` for a password reset
 * that never left the process.
 */
export const mailCredentialMissing = (environment: Environment): MailError =>
  new MailError({
    code: 'X_MAIL_CREDENTIAL_MISSING',
    cause:
      `none of SMTP_URL, RESEND_API_KEY or SES_REGION is set in ${environment}, so this process ` +
      'has no transport — the message was not delivered and was not queued anywhere',
    fix:
      'set SMTP_URL="smtps://user:pass@host:465" (or RESEND_API_KEY=re_..., or SES_REGION with ' +
      'SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY) and ' +
      'MAIL_FROM="App <no-reply@yourdomain.test>" in the deployment environment, then restart',
    meta: { environment, missing: ['SMTP_URL', 'RESEND_API_KEY', 'SES_REGION'] },
  });

/**
 * Why a header was refused. Two reasons, one code, as `AddressRefusal` is for the envelope: a
 * non-ASCII MAILBOX in an address header was raised with the line-break cause, which named a
 * character the value did not hold.
 */
export type HeaderRefusal = 'line-break' | 'non-ascii';

/** The `send()` option each address header comes from; `From` is the transport's own config. */
const ADDRESS_OPTION: ReadonlyMap<string, string> = new Map([
  ['To', 'to'],
  ['Cc', 'cc'],
  ['Reply-To', 'replyTo'],
]);

/**
 * The domain as punycode is the ASCII form; a non-ASCII LOCAL part has none and needs another
 * mailbox. The example is fixed text — an address is recipient data, never echoed back.
 */
const nonAsciiFix = (name: string): string => {
  const option = ADDRESS_OPTION.get(name);
  return option === undefined
    ? 'set mail.from in app.config.ts to an ASCII mailbox, e.g. no-reply@example.test'
    : `pass the mailbox's ASCII form, the domain as punycode: send(mail, data, { ${option}: 'jose@xn--exmple-cua.test', locale })`;
};

/**
 * A CR or LF inside a header value ends the header early and lets whatever follows become new
 * headers — the recipient list, a forged `From`. Interpolated data reaches `Subject`, so this is
 * refused rather than stripped: silently rewriting a subject is its own surprise.
 */
export const headerInvalid = (
  name: string,
  mailId: string,
  reason: HeaderRefusal = 'line-break',
): MailError =>
  new MailError({
    code: 'X_MAIL_HEADER_INVALID',
    cause:
      reason === 'line-break'
        ? `the "${name}" header of mail "${mailId}" contains a CR or LF, which would inject headers`
        : `the "${name}" header of mail "${mailId}" holds a non-ASCII byte in its mailbox, and this package negotiates no SMTPUTF8, so the address cannot be written as a header`,
    fix:
      reason === 'line-break'
        ? `strip line breaks from the value before it reaches the header: ` +
          `t('mail.${mailId}.subject', { ...data, x: String(x).replace(/[\\r\\n]+/g, ' ') })`
        : nonAsciiFix(name),
    meta: { header: name, mailId, reason },
  });

/**
 * Which half of the SMTP envelope an address belongs to. A closed union, and it lives here rather
 * than beside the check for the same reason `SendStage` does: the two halves come from two
 * different places — a config line and a `send()` call — so each needs its own `fix`, and a typo
 * has to be a compile error instead of a lookup that quietly misses.
 */
export type EnvelopeAddressField = 'sender' | 'recipient';

const ADDRESS_FIXES: Readonly<Record<EnvelopeAddressField, string>> = {
  sender: 'set mail.from in app.config.ts to a bare address, e.g. no-reply@example.test',
  recipient: "pass bare addresses: send(mail, data, { to: ['ada@example.test'], locale })",
};

/**
 * Why an envelope address was refused. Two reasons, one code: the value is recipient data either
 * way, so a caller reading `meta.reason` is the only way to tell them apart — and a `cause` naming
 * both would be wrong half the time, which is the misdirection axiom 4 refuses.
 */
export type AddressRefusal = 'injection' | 'non-ascii';

const ADDRESS_CAUSES: Readonly<Record<AddressRefusal, string>> = {
  injection:
    'holds a control character or an angle bracket, which would end the command line and inject SMTP commands',
  'non-ascii':
    'holds a non-ASCII byte in its mailbox, and this package negotiates no SMTPUTF8, so it cannot be written to the command line at all',
};

/**
 * `MAIL FROM:<…>` and `RCPT TO:<…>` are built by interpolation, so a CR or LF in an address ends
 * the command line and lets the rest of it run as SMTP commands of its own — arbitrary relay over
 * the app's authenticated connection. Refused rather than stripped, like a header: a stripped
 * address is a different address, so sanitising silently redirects the mail instead of stopping it.
 * The value never appears here — an address is recipient data, which this package keeps out of
 * every string it writes itself.
 */
export const addressInvalid = (
  field: EnvelopeAddressField,
  reason: AddressRefusal = 'injection',
): MailError =>
  new MailError({
    code: 'X_MAIL_ADDRESS_INVALID',
    cause: `the SMTP envelope ${field} address ${ADDRESS_CAUSES[reason]}`,
    fix: ADDRESS_FIXES[field],
    meta: { field, reason },
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
  readonly driver: 'smtp' | 'resend' | 'ses';
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
    // The classification the queue acts on. `meta.retryable` below is an operator-facing FACT and
    // nothing reads it to make a decision — `nextRetryForError` reads `error.retry`, so a failure
    // that only reported itself in `meta` was a failure the worker retried anyway.
    retry: failure.retryable ? 'retryable' : 'terminal',
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

/**
 * The app's `setMailTransform` hook threw, or handed back something that is not a message. The
 * send FAILS: delivering the untransformed mail would be a send the app believes was tracked (or
 * rewritten) and was not, and nothing downstream could tell the difference.
 */
export const transformFailed = (mailId: string, reason: string): MailError =>
  new MailError({
    code: 'X_MAIL_TRANSFORM_FAILED',
    cause: `the mail transform failed for "${mailId}": ${reason} — the mail was not sent`,
    fix: `make the setMailTransform() hook return { subject, html, text } strings for "${mailId}" (return the rendered argument unchanged for a mail it does not track), then retry the send`,
    meta: { mailId },
  });
