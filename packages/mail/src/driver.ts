// Single responsibility: the transport seam. One `MailDriver` interface, four implementations,
// and a module-level ambient driver so `send()` never knows which one is installed. Swapping
// SMTP for Resend is an `app.config.ts` line and zero template changes.

import { nanoid, logger as rootLogger } from '@ultimat3/core';
import { driverUnavailable, transportNotImplemented } from './errors';

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

function accepted(message: MailMessage): readonly string[] {
  return [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])];
}

function resultFor(driver: string, message: MailMessage, id: string): SendResult {
  return {
    id,
    driver,
    accepted: accepted(message),
    queued: false,
    idempotencyKey: message.idempotencyKey ?? id,
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

export interface SmtpDriverOptions {
  /** `smtps://user:pass@host:465`. Read from `SMTP_URL`, never hardcoded. */
  readonly url: string;
  readonly from: string;
  readonly poolSize?: number | undefined;
}

/** Interface-complete; the wire protocol is not in this build. */
export function createSmtpDriver(options: SmtpDriverOptions): MailDriver {
  return {
    name: 'smtp',
    send(_message: MailMessage): Promise<SendResult> {
      throw transportNotImplemented(
        'smtp',
        `set SMTP_URL (currently "${redactUrl(options.url)}") and run: x mail doctor --json`,
      );
    },
  };
}

export interface ResendDriverOptions {
  /** Read from `RESEND_API_KEY`. */
  readonly apiKey: string;
  readonly from: string;
}

/** Interface-complete; the HTTP call is not in this build. */
export function createResendDriver(options: ResendDriverOptions): MailDriver {
  return {
    name: 'resend',
    send(_message: MailMessage): Promise<SendResult> {
      const state = options.apiKey === '' ? 'empty' : 'set';
      throw transportNotImplemented(
        'resend',
        `set RESEND_API_KEY (currently ${state}), then run: x mail doctor --json`,
      );
    },
  };
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.password = '';
    return parsed.href;
  } catch {
    return 'not a URL';
  }
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
