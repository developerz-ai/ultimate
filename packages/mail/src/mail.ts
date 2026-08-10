// Single responsibility: the `defineMail` primitive, the mail registry, and `send`.
// `locale` is required by the TYPE, not by a runtime check alone: an email in the wrong
// language is a real, unnoticed production bug, and the ambient request locale is the one
// piece of context that a background send cannot recover after the fact.

import { assert, DEFAULT_TIME_ZONE, tryUseContext } from '@ultimat3/core';
import { jobDriver } from '@ultimat3/jobs';
import { parse, type StandardSchemaV1 } from '@ultimat3/schema';
import type { MailTemplate } from './blocks';
import { type MailMessage, mailDriver, type SendResult } from './driver';
import { localeMissing, mailDuplicate, templateUnknown } from './errors';
import { mailIdempotencyKey } from './idempotency';
import { sendMailJob } from './job';
import { BASE_LAYOUT } from './layout';
import { type RenderableMail, renderMail } from './render';

export interface MailDefinition<I> extends RenderableMail<I> {
  readonly id: string;
  /** An i18n key, never a literal subject line. */
  readonly subject: string;
  readonly template: MailTemplate<I>;
  readonly input: StandardSchemaV1<unknown, I>;
  readonly layout: string;
}

export interface MailInit<I> {
  readonly id: string;
  readonly subject: string;
  readonly template: MailTemplate<I>;
  readonly input: StandardSchemaV1<unknown, I>;
  /** Defaults to the framework's `base` layout. */
  readonly layout?: string | undefined;
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
}

const registry = new Map<string, AnyMailDefinition>();

export function defineMail<I>(init: MailInit<I>): MailDefinition<I> {
  if (registry.has(init.id)) throw mailDuplicate(init.id);
  const definition: MailDefinition<I> = {
    id: init.id,
    subject: init.subject,
    template: init.template,
    input: init.input,
    layout: init.layout ?? BASE_LAYOUT,
  };
  registry.set(init.id, definition);
  return definition;
}

export function mailFor(id: string): AnyMailDefinition | undefined {
  return registry.get(id);
}

export function registeredMails(): readonly AnyMailDefinition[] {
  return [...registry.values()].sort((a, b) => a.id.localeCompare(b.id));
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
 * between the queue and the transport. Exported so `x mail preview` and tests can render
 * without delivering anything.
 */
export function renderMessage<I>(
  mail: MailDefinition<I>,
  data: I,
  options: SendOptions,
): MailMessage {
  assertLocale(mail.id, options.locale);
  if (registry.get(mail.id) === undefined) throw templateUnknown(mail.id, registeredMailIds());

  const to = typeof options.to === 'string' ? [options.to] : [...options.to];
  assert(
    to.length > 0,
    `send(${mail.id}, ...) was called with an empty recipient list`,
    'pass { to: user.email } — one address, or a non-empty array of addresses',
  );

  const input = parse(mail.input, data, `${mail.id}.input`);
  const tz = options.tz ?? tryUseContext()?.tz ?? DEFAULT_TIME_ZONE;
  const rendered = renderMail(mail, input, {
    locale: options.locale,
    tz,
    unsubscribeUrl: options.unsubscribeUrl,
  });

  return {
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
    idempotencyKey: options.idempotencyKey,
  };
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
  const message = renderMessage(mail, data, options);
  const key = mailIdempotencyKey(message);
  const queue = jobDriver();

  if (options.sync === true || queue === undefined) {
    // The key is reported even inline, so a caller can dedupe its own retries either way.
    return { ...(await mailDriver().send(message)), idempotencyKey: key };
  }

  const enqueued = await queue.enqueue({
    name: sendMailJob.name,
    queue: sendMailJob.queue,
    input: message,
    idempotencyKey: key,
    maxAttempts: sendMailJob.retry.attempts,
    onConflict: 'dedupe',
  });

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
