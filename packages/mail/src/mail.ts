// Single responsibility: the `defineMail` primitive, the mail registry, and `send`.
// `locale` is required by the TYPE, not by a runtime check alone: an email in the wrong
// language is a real, unnoticed production bug, and the ambient request locale is the one
// piece of context that a background send cannot recover after the fact.

import { assert, DEFAULT_TIME_ZONE, tryUseContext } from '@ultimat3/core';
import type { TranslationMiss } from '@ultimat3/i18n';
import { jobDriver } from '@ultimat3/jobs';
import { parse, type StandardSchemaV1, t } from '@ultimat3/schema';
import type { MailTemplate } from './blocks';
import { deliverMail } from './deliver';
import { envelopeRecipients, type MailMessage, type SendResult } from './driver';
import { assertRecipientAddress } from './envelope-address';
import { localeMissing, mailDuplicate, mailKeyMissing, templateUnknown } from './errors';
import { assertHeaderSafe } from './header-safety';
import { mailIdempotencyKey } from './idempotency';
import { sendMailJob } from './job';
import { BASE_LAYOUT } from './layout';
import { assertPreview } from './preview-check';
import { type RenderableMail, renderMail } from './render';
import { applyMailTransform } from './transform';

export interface MailDefinition<I> extends RenderableMail<I> {
  readonly id: string;
  /** An i18n key, never a literal subject line. */
  readonly subject: string;
  readonly template: MailTemplate<I>;
  readonly input: StandardSchemaV1<unknown, I>;
  readonly layout: string;
  /** Sample data a preview renders: never production rows. */
  readonly preview?: MailPreview<I> | undefined;
}

/** A preview's data, or a function of the locale for copy that differs by language. */
export type MailPreview<I> = I | ((locale: string) => I);

export interface MailInit<I> {
  readonly id: string;
  readonly subject: string;
  readonly template: MailTemplate<I>;
  readonly input: StandardSchemaV1<unknown, I>;
  /** Defaults to the framework's `base` layout. */
  readonly layout?: string | undefined;
  /**
   * What `x mail preview` and the `/_x` mail panel render, in every locale, with no flow
   * triggered. Type-checked against `input` here, and a value is parsed by it at definition
   * (`X_MAIL_PREVIEW_INVALID`); a function is parsed at each render.
   */
  readonly preview?: MailPreview<I> | undefined;
}

export interface SendOptions {
  readonly to: string | readonly string[];
  /** BCP-47. Required — there is no ambient fallback for a message the user reads later. */
  readonly locale: string;
  /** IANA zone for every date in the body. Defaults to the request context, then UTC. */
  readonly tz?: string | undefined;
  readonly replyTo?: string | undefined;
  readonly cc?: readonly string[] | undefined;
  readonly bcc?: readonly string[] | undefined;
  readonly unsubscribeUrl?: string | undefined;
  /**
   * Default `true`: `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058) rides with
   * `List-Unsubscribe`, and it is the supported path — one url for the header and the footer, a
   * page whose `GET` confirms and whose `POST` unsubscribes (`defineRoute({ post: '<action>' })`).
   * `false` is the fallback for a url that cannot take the POST: the header and the footer link
   * stay, the POST promise goes.
   */
  readonly unsubscribeOneClick?: boolean | undefined;
  readonly idempotencyKey?: string | undefined;
  /** Deliver inline instead of through the queue. Tests and CLI one-shots only. */
  readonly sync?: boolean | undefined;
}

/**
 * The registry erases the payload type so heterogeneous mails share one map. `template`
 * stays assignable because `never` flows into any `TemplateArgs<I>`; `input` widens to
 * `unknown` on the output side, which is exactly what `parse` re-establishes at send time.
 */
export interface AnyMailDefinition {
  readonly id: string;
  readonly subject: string;
  readonly layout: string;
  readonly input: StandardSchemaV1<unknown, unknown>;
  readonly template: MailTemplate<never>;
  readonly preview?: unknown;
}

const registry = new Map<string, AnyMailDefinition>();

export function defineMail<I>(init: MailInit<I>): MailDefinition<I> {
  if (registry.has(init.id)) throw mailDuplicate(init.id);
  // A value is checked where it is written; a function of the locale, at each render.
  if (init.preview !== undefined && typeof init.preview !== 'function') {
    assertPreview(init.id, init.input, init.preview);
  }
  const definition: MailDefinition<I> = {
    id: init.id,
    subject: init.subject,
    template: init.template,
    input: init.input,
    layout: init.layout ?? BASE_LAYOUT,
    ...(init.preview === undefined ? {} : { preview: init.preview }),
  };
  registry.set(init.id, definition);
  return definition;
}

export function mailFor(id: string): AnyMailDefinition | undefined {
  return registry.get(id);
}

export function registeredMails(): readonly AnyMailDefinition[] {
  // Through `registeredMailIds`, so the two views share ONE order: the code-unit sort. It was
  // `localeCompare` here, which puts `welcome` before `Zeta` where the id list puts it after.
  return registeredMailIds().flatMap((id) => registry.get(id) ?? []);
}

export function registeredMailIds(): readonly string[] {
  return [...registry.keys()].sort();
}

/** Test/CLI seam: drop every registered mail. */
export function resetMails(): void {
  registry.clear();
}

/**
 * Validate, render, and build the envelope — everything `send` does before it decides
 * between the queue and the transport. Exported so a host or a test can render a mail without
 * delivering it — the `/_x` mail panel and `mailIdempotencyKey`'s callers both need that.
 */
export function renderMessage<I>(
  mail: MailDefinition<I>,
  data: I,
  options: SendOptions,
): MailMessage {
  return renderChecked(mail, data, options).message;
}

/**
 * Render without delivering, with the misses a preview shows instead of refusing on: the `/_x`
 * panel and `x mail preview` (`preview.ts`) read this, `send` never does.
 */
export function renderWithMisses<I>(
  mail: MailDefinition<I>,
  data: I,
  options: SendOptions,
): { readonly message: MailMessage; readonly misses: readonly TranslationMiss[] } {
  return renderChecked(mail, data, options);
}

function renderChecked<I>(
  mail: MailDefinition<I>,
  data: I,
  options: SendOptions,
): { readonly message: MailMessage; readonly misses: readonly TranslationMiss[] } {
  assertLocale(mail.id, options.locale);
  if (registry.get(mail.id) === undefined) throw templateUnknown(mail.id, registeredMailIds());

  const to = typeof options.to === 'string' ? [options.to] : [...options.to];
  assert(
    to.length > 0,
    `send(${mail.id}, ...) was called with an empty recipient list`,
    'pass { to: user.email } — one address, or a non-empty array of addresses',
  );

  const input = parse(mail.input, data, `${mail.id}.input`);
  // The queue schema's own rule (`t.url`), so an unparseable url is refused here rather than
  // delivered inline as `List-Unsubscribe: <not a url>` and refused by a worker when queued.
  if (options.unsubscribeUrl !== undefined) {
    parse(t.url, options.unsubscribeUrl, `${mail.id}.unsubscribeUrl`);
  }
  const tz = options.tz ?? tryUseContext()?.tz ?? DEFAULT_TIME_ZONE;
  const rendered = renderMail(mail, input, {
    locale: options.locale,
    tz,
    unsubscribeUrl: options.unsubscribeUrl,
  });

  const message: MailMessage = {
    mailId: mail.id,
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    locale: options.locale,
    tz,
    replyTo: options.replyTo,
    cc: options.cc,
    bcc: options.bcc,
    unsubscribeUrl: options.unsubscribeUrl,
    unsubscribeOneClick: options.unsubscribeOneClick,
    idempotencyKey: options.idempotencyKey,
  };
  // Here, not in a driver: interpolated data reaches `Subject`, and whether a break in it injects
  // headers is a property of the message, not of whichever transport this deploy happens to run.
  // Checked before the queue too, so the refusal lands on the `send()` call site that made it
  // rather than on a worker three retries later.
  assertHeaderSafe(message);
  // The recipient rule, after the header gate so a line break keeps its own code: what the queue
  // schema refuses is refused HERE, on every driver, rather than answered `queued: true` and then
  // refused by the worker's parse — one rule on both paths (`s1-t4 #3`).
  const replyTo = message.replyTo === undefined ? [] : [message.replyTo];
  for (const address of [...envelopeRecipients(message), ...replyTo]) {
    assertRecipientAddress('recipient', address);
  }
  return { message, misses: rendered.misses };
}

/**
 * Enqueues by default so a slow SMTP host never blocks a request. Falls back to an inline
 * send when no job driver is configured (a script, a test, `x` one-shots) — the alternative
 * would be silently dropping mail in exactly the setups where it is easiest to miss.
 */
export async function send<I>(
  mail: MailDefinition<I>,
  data: I,
  options: SendOptions,
): Promise<SendResult> {
  const { message: rendered, misses } = renderChecked(mail, data, options);
  // Here and not in `renderMessage`: a preview should show the miss, and a customer never should.
  // A mail is the one surface where a loud miss cannot be taken back.
  if (misses.length > 0) throw mailKeyMissing(mail.id, options.locale, misses);
  // Transform BEFORE the key: the key, the queue row and every retry carry the transformed bytes,
  // and the job never re-runs the hook. Not in `renderMessage`, which previews call.
  const message = await applyMailTransform(rendered);
  const key = mailIdempotencyKey(message);

  if (options.sync === true || jobDriver() === undefined) {
    // The key is reported even inline, so a caller can dedupe its own retries either way.
    return { ...(await deliverMail(message)), idempotencyKey: key };
  }

  // Through the handle, which is the facade under the producer span — never `queue.enqueue`:
  // inside a transaction the row is STAGED on the caller's connection and published after COMMIT,
  // so a handler that rolls back after sending mails nobody (`s1-con #3`). Outside one, the facade
  // publishes straight to the same driver. The handle adds the `job.enqueue` event and the span a
  // bare `jobsFacade().enqueue` skipped. The key is `mailIdempotencyKey`; the driver dedupes on it.
  const enqueued = await sendMailJob.enqueue(message);

  return {
    id: enqueued.id,
    driver: 'queue',
    accepted: [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])],
    queued: true,
    idempotencyKey: key,
  };
}

/** Send by id — what the CLI, MCP tools and generated code use. `data` is parsed, not trusted. */
export async function sendById(
  id: string,
  data: unknown,
  options: SendOptions,
): Promise<SendResult> {
  const mail = registry.get(id);
  if (mail === undefined) throw templateUnknown(id, registeredMailIds());
  // The one cast in the package: the registry erased `I`, and `send` re-parses `data`
  // through the mail's own schema before it reaches the template.
  return await send(mail as MailDefinition<unknown>, data, options);
}

/**
 * The runtime backstop for JS callers and generated code — TypeScript already forbids
 * omitting `locale`, so reaching this throw means the type was cast away somewhere.
 */
function assertLocale(mailId: string, locale: unknown): asserts locale is string {
  if (typeof locale !== 'string' || locale.trim() === '') throw localeMissing(mailId);
}
