// Single responsibility: the SMTP transport as a `MailDriver` — parse `SMTP_URL` once at boot,
// render the envelope to MIME, and run one conversation per message over one connection. The
// protocol lives in `smtp-client.ts` and the socket in `smtp-socket.ts`; this file wires them.

import {
  type Clock,
  ConfigInvalidError,
  finiteCount,
  isUltimateError,
  nanoid,
  renderThrowable,
  systemClock,
} from '@ultimat3/core';
import type { SendResult } from './driver';
import { envelopeRecipients, type MailDriver, type MailMessage, resultFor } from './driver';
import { sendFailed } from './errors';
import { mailMessageIdToken } from './idempotency';
import { addressDomain, addressSpec, buildMimeMessage } from './mime';
import {
  type SmtpConnector,
  type SmtpSessionOptions,
  type SmtpTarget,
  smtpDeliver,
} from './smtp-client';
import { bunSmtpStream } from './smtp-socket';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POOL_SIZE = 4;
const IMPLICIT_TLS_PORT = 465;
const SUBMISSION_PORT = 587;

export interface SmtpDriverOptions {
  /** `smtps://user:pass@host:465`. Read from `SMTP_URL`, never hardcoded. */
  readonly url: string;
  /** `Postly <no-reply@postly.test>`. Also the envelope sender and the Message-ID domain. */
  readonly from: string;
  /** Max connections open at once. A burst of sends queues instead of opening one socket each. */
  readonly poolSize?: number | undefined;
  /** Deadline for any single read or write. Default 30s. */
  readonly timeoutMs?: number | undefined;
  /** The `EHLO` name. Defaults to the from address's domain, which is what SPF checks anyway. */
  readonly clientName?: string | undefined;
  /** Speak to a server that offers no STARTTLS. Off by default: mail and password in the clear. */
  readonly allowInsecure?: boolean | undefined;
  readonly clock?: Clock | undefined;
  /** Injected in tests; production dials with `Bun.connect`. */
  readonly connect?: SmtpConnector | undefined;
}

interface SmtpUrl {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  readonly user?: string | undefined;
  readonly password?: string | undefined;
}

/** `smtps://` is implicit TLS on 465; `smtp://` starts in the clear and upgrades with STARTTLS. */
function parseSmtpUrl(raw: string): SmtpUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigInvalidError({
      cause: 'SMTP_URL is not a URL',
      fix: 'set SMTP_URL to smtps://user:pass@host:465 (implicit TLS) or smtp://host:587',
    });
  }
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') {
    throw new ConfigInvalidError({
      cause: `SMTP_URL uses the "${url.protocol}" scheme, which is not an SMTP one`,
      fix: 'set SMTP_URL to smtps://user:pass@host:465 (implicit TLS) or smtp://host:587',
    });
  }
  if (url.hostname === '') {
    throw new ConfigInvalidError({
      cause: 'SMTP_URL names no host',
      fix: 'set SMTP_URL to smtps://user:pass@host:465 (implicit TLS) or smtp://host:587',
    });
  }
  const tls = url.protocol === 'smtps:';
  return {
    host: url.hostname,
    port: url.port === '' ? (tls ? IMPLICIT_TLS_PORT : SUBMISSION_PORT) : Number(url.port),
    tls,
    // Credentials are percent-encoded in a URL; a password with `@` or `/` is otherwise unusable.
    ...(url.username === '' ? {} : { user: decodeURIComponent(url.username) }),
    ...(url.password === '' ? {} : { password: decodeURIComponent(url.password) }),
  };
}

/**
 * `poolSize: 0` is the one config mistake this driver could not report: the limiter would park
 * every send on a slot that is never handed out, with no deadline on the wait, so the job would
 * neither fail nor retry and the worker slot would be gone until the process restarted. A silent
 * deadlock is worse than any error, so this fails at construction like every other bad value.
 */
function resolvePoolSize(poolSize: number | undefined): number {
  if (poolSize === undefined) return DEFAULT_POOL_SIZE;
  if (!Number.isInteger(poolSize) || poolSize < 1) {
    throw new ConfigInvalidError({
      cause: `the smtp driver was configured with poolSize: ${poolSize}, which opens no connection`,
      fix: `set poolSize to a whole number >= 1 in app.config.ts, or drop it for ${DEFAULT_POOL_SIZE}`,
      meta: { poolSize },
    });
  }
  return poolSize;
}

/** At most `size` conversations at a time — the honest meaning of `poolSize` for one-shot sends. */
function createLimiter(size: number): (run: () => Promise<SendResult>) => Promise<SendResult> {
  const waiting: (() => void)[] = [];
  let active = 0;
  // The slot is handed straight to the next waiter rather than freed and re-taken, so the count
  // is never momentarily wrong: "free it, then let whoever wakes first claim it" only holds while
  // nothing can run between the two, which is a scheduling detail, not an invariant.
  const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) active -= 1;
    else next();
  };
  return async (run) => {
    if (active >= size) await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await run();
    } finally {
      release();
    }
  };
}

export function createSmtpDriver(options: SmtpDriverOptions): MailDriver {
  const target = parseSmtpUrl(options.url);
  if (options.from.trim() === '') {
    throw new ConfigInvalidError({
      cause: 'the smtp driver was configured without a from address',
      fix: 'set mail.from in app.config.ts to an address the SMTP server will relay for',
    });
  }
  const clock = options.clock ?? systemClock;
  const connect = options.connect ?? bunSmtpStream;
  // Refused where `poolSize` already is. The deadline reaches `setTimeout(fn, timeoutMs)` in the
  // conversation and in the socket, and `setTimeout(fn, NaN)` is `setTimeout(fn, 0)` — so a
  // non-finite deadline does not disable itself, it fires on the next tick and every send fails
  // "the server sent nothing for NaNms". `0` is the same failure spelled deliberately.
  const timeoutMs = finiteCount(
    'createSmtpDriver',
    'timeoutMs',
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    1,
  );
  const limit = createLimiter(resolvePoolSize(options.poolSize));
  const session: SmtpSessionOptions = {
    clientName: options.clientName ?? addressDomain(options.from),
    secure: target.tls,
    allowInsecure: options.allowInsecure ?? false,
    timeoutMs,
    ...(target.user === undefined ? {} : { user: target.user }),
    ...(target.password === undefined ? {} : { password: target.password }),
  };
  const dial: SmtpTarget = { host: target.host, port: target.port, tls: target.tls, timeoutMs };
  // `smtps://` is encrypted from the first byte; a submission port has to be told to upgrade, or
  // the probe named in the fix lines below opens a socket and then waits forever for a handshake.
  const starttls = target.tls ? '' : ' -starttls smtp';

  return {
    name: 'smtp',
    send: (message: MailMessage): Promise<SendResult> => limit(() => deliver(message)),
  };

  async function deliver(message: MailMessage): Promise<SendResult> {
    // The Message-ID is the id the recipient's mailbox shows, so it is also the id we report: an
    // SMTP `250` carries no identifier a caller could correlate with anything.
    //
    // It is CONTENT-DERIVED, so every attempt of one send presents the same one. A `nanoid` here
    // made a retry after a timeout past `DATA` a second, unrelated email — the case
    // `SendResult.idempotencyKey` claims is one message, and the case Resend's `Idempotency-Key`
    // header has always covered. It is a one-way digest and not the key itself, which is what
    // answers the objection the key raises: the key holds the recipient list, blind ones included,
    // and this header is visible to all of them.
    const messageId = `<${message.mailId}.${mailMessageIdToken(message)}@${addressDomain(options.from)}>`;
    const data = buildMimeMessage(message, {
      from: options.from,
      messageId,
      date: clock.now(),
      boundary: `x-ultimate-${nanoid(20)}`,
    });

    const stream = await connect(dial).catch((error: unknown) => {
      throw sendFailed({
        driver: 'smtp',
        stage: 'connect',
        detail: `${target.host}:${target.port}, from SMTP_URL in .env — ${messageOf(error)}`,
        retryable: true,
        fix: `openssl s_client${starttls} -connect ${target.host}:${target.port}`,
      });
    });

    try {
      await smtpDeliver(
        stream,
        { from: addressSpec(options.from), recipients: envelopeRecipients(message), data },
        session,
      );
      return resultFor('smtp', message, messageId);
    } catch (error) {
      // A framework error already names its stage; anything else (a socket reset mid-DATA) would
      // otherwise escape as a bare Error and lose the code the queue's dead-letter view reads.
      if (isUltimateError(error)) throw error;
      throw sendFailed({
        driver: 'smtp',
        stage: 'data',
        detail: `${messageOf(error)} — the mail log on ${target.host} records why it dropped this`,
        retryable: true,
        fix: `openssl s_client -crlf${starttls} -connect ${target.host}:${target.port}`,
      });
    } finally {
      stream.close();
    }
  }
}

/**
 * `renderThrowable`, never `instanceof` + `.message` or `String(value)`: both RUN code on the
 * caught value — a prototype read and a `toString` — and a throw here would escape the `catch`
 * that exists to keep `X_MAIL_SEND_FAILED` on a dropped connection.
 */
function messageOf(error: unknown): string {
  return renderThrowable(error);
}
