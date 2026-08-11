// Single responsibility: the transport seam. One `MailDriver` interface, the two local
// implementations (memory + log), and a module-level ambient driver so `send()` never knows
// which one is installed. The two production transports live in `driver-smtp.ts` and
// `driver-resend.ts`; swapping one for the other is an `app.config.ts` line and zero template
// changes.

import { nanoid, logger as rootLogger } from '@ultimat3/core';
import { driverUnavailable } from './errors';
import { mailIdempotencyKey } from './idempotency';

/** The rendered envelope. Everything a transport needs; nothing it does not. */
export interface MailMessage {
  readonly mailId: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly locale: string;
  readonly tz: string;
  readonly replyTo?: string | undefined;
  readonly cc?: readonly string[] | undefined;
  readonly bcc?: readonly string[] | undefined;
  readonly unsubscribeUrl?: string | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface SendResult {
  /** Provider message id, or a local id for the memory/log drivers. */
  readonly id: string;
  readonly driver: string;
  readonly accepted: readonly string[];
  /** True when the message was handed to the queue instead of a transport. */
  readonly queued: boolean;
  readonly idempotencyKey: string;
}

export interface MailDriver {
  readonly name: string;
  send(message: MailMessage): Promise<SendResult>;
}

/**
 * RFC 8058 one-click unsubscribe. Gmail and Yahoo require it for bulk senders and
 * reward it for transactional ones, so it is computed here rather than per driver.
 */
export function messageHeaders(message: MailMessage): Readonly<Record<string, string>> {
  const headers: Record<string, string> = { 'Auto-Submitted': 'auto-generated' };
  if (message.replyTo !== undefined) headers['Reply-To'] = message.replyTo;
  if (message.unsubscribeUrl !== undefined) {
    headers['List-Unsubscribe'] = `<${message.unsubscribeUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  return headers;
}

/**
 * Every address the envelope is delivered to. `Bcc` is one of them and never a header —
 * an SMTP `RCPT TO` carries it, and putting it in the message would leak the blind list.
 */
export function envelopeRecipients(message: MailMessage): readonly string[] {
  return [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])];
}

/** The shared `SendResult` shape, so a transport reports acceptance identically to every other. */
export function resultFor(driver: string, message: MailMessage, id: string): SendResult {
  return {
    id,
    driver,
    accepted: envelopeRecipients(message),
    queued: false,
    // The content-derived key, not the provider's id: it is the same across every attempt of the
    // same send, which is what a caller deduping its own retries needs it to be.
    idempotencyKey: mailIdempotencyKey(message),
  };
}

export interface SentMail {
  readonly at: Date;
  readonly message: MailMessage;
  readonly result: SendResult;
}

/**
 * Dev + test driver. Retains every message it accepts and exposes them, which is what the
 * `/_x` mail panel reads to show the last mails rendered by the running app — a real inbox
 * is not part of the local loop.
 */
export interface MemoryMailDriver extends MailDriver {
  readonly name: 'memory';
  readonly sent: readonly SentMail[];
  /** Newest first, so the panel and assertions do not index backwards. */
  outbox(): readonly SentMail[];
  lastTo(address: string): SentMail | undefined;
  clear(): void;
}

export function createMemoryDriver(): MemoryMailDriver {
  const sent: SentMail[] = [];
  return {
    name: 'memory',
    sent,
    send(message: MailMessage): Promise<SendResult> {
      const result = resultFor('memory', message, `mem_${nanoid(12)}`);
      sent.push({ at: new Date(), message, result });
      return Promise.resolve(result);
    },
    outbox: () => [...sent].reverse(),
    lastTo: (address) => [...sent].reverse().find((entry) => entry.message.to.includes(address)),
    clear: () => {
      sent.length = 0;
    },
  };
}

/**
 * Whether this driver caught the message instead of sending it. A host asks before reading
 * `outbox()` — the `/_x` mail panel exists only when nothing was actually delivered, and a real
 * transport has no record to show. Narrowed on the retained list rather than on `name`, so a
 * driver that merely calls itself `memory` cannot pass.
 */
export function isMemoryDriver(driver: MailDriver): driver is MemoryMailDriver {
  return driver.name === 'memory' && typeof (driver as MemoryMailDriver).outbox === 'function';
}

/**
 * Structured log line per message through core's `logger` — the default for a worker that
 * has no credentials yet. Bodies are never logged; a mail body is user data.
 */
export function createLogDriver(logger = rootLogger): MailDriver {
  return {
    name: 'log',
    send(message: MailMessage): Promise<SendResult> {
      const result = resultFor('log', message, `log_${nanoid(12)}`);
      logger.info('mail.send', {
        mailId: message.mailId,
        to: message.to.length,
        subject: message.subject,
        locale: message.locale,
        idempotencyKey: result.idempotencyKey,
      });
      return Promise.resolve(result);
    },
  };
}

let ambient: MailDriver | undefined;

/** Set once at boot from `app.config.ts`. One driver per process, like the job driver. */
export function setMailDriver(driver: MailDriver): void {
  ambient = driver;
}

export function tryMailDriver(): MailDriver | undefined {
  return ambient;
}

/** Throws `X_MAIL_DRIVER_UNAVAILABLE` rather than silently dropping mail on the floor. */
export function mailDriver(): MailDriver {
  if (ambient === undefined) throw driverUnavailable('setMailDriver() was never called');
  return ambient;
}

export function resetMailDriver(): void {
  ambient = undefined;
}
