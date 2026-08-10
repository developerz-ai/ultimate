// Single responsibility: the Resend HTTPS transport. One POST per message onto the shared
// MailDriver contract — no SDK, `fetch` is the whole client. Construction fails fast on a
// missing key or an empty from address, so a misconfiguration never waits for the first send.

import { ConfigInvalidError, EnvMissingError, logger, nanoid } from '@ultimat3/core';
import type { MailDriver, MailMessage, SendResult } from './driver';
import { messageHeaders, resultFor } from './driver';
import { sendFailed } from './errors';
import { mailIdempotencyKey } from './idempotency';

export const RESEND_BASE_URL = 'https://api.resend.com';

/** Just the call. `typeof fetch` also carries `preconnect`, which no test double should have to. */
export type MailFetch = (input: string, init: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_DETAIL_LENGTH = 200;

// A 4xx here means the same request, unchanged, might land: a throttle or a momentary
// conflict. Every other 4xx is a config problem retrying cannot fix.
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429]);

export interface ResendDriverOptions {
  /** Read from `RESEND_API_KEY`. A literal key in app.config.ts is a key in git. */
  readonly apiKey: string;
  /** `Postly <no-reply@postly.test>`. Must be a domain verified with Resend. */
  readonly from: string;
  /** Override for a self-hosted proxy or a test double. Defaults to `RESEND_BASE_URL`. */
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  /** Injected in tests; production uses the global. */
  readonly fetch?: MailFetch | undefined;
}

function requireApiKey(apiKey: string): string {
  if (apiKey.trim() !== '') return apiKey;
  throw new EnvMissingError({
    cause: 'RESEND_API_KEY is not set, so the resend driver cannot authenticate',
    fix: "set RESEND_API_KEY in .env (or the container's secret store), then re-run",
    meta: { missing: 'RESEND_API_KEY' },
  });
}

function requireFrom(from: string): string {
  if (from.trim() !== '') return from;
  throw new ConfigInvalidError({
    cause: 'the resend driver was configured without a from address',
    fix: 'set mail.from in app.config.ts to a domain verified with Resend',
  });
}

/** `retryable` for a throttle or a transient conflict; everything else is a config problem. */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || RETRYABLE_STATUSES.has(status);
}

function fixFor(status: number): string {
  if (status === 401 || status === 403) {
    return 'set RESEND_API_KEY to a current key from https://resend.com/api-keys, then retry';
  }
  if (status === 422) {
    return 'verify the sending domain in the Resend dashboard: https://resend.com/domains';
  }
  if (status === 429) {
    return 'the job already retries with backoff — raise the rate limit on the Resend plan';
  }
  return 'check the request against https://resend.com/docs/api-reference/emails/send-email';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Prefers Resend's own message; falls back to the raw body, capped so a huge page can't flood logs. */
async function detailFor(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (text === '') return `HTTP ${response.status} with an empty body`;
  try {
    const parsed: unknown = JSON.parse(text);
    const message = isRecord(parsed) ? parsed['message'] : undefined;
    if (typeof message === 'string' && message !== '') return message;
  } catch {
    // Not JSON — fall through to the truncated raw text below.
  }
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH)}…` : text;
}

/** A 2xx is acceptance regardless of body shape; the id is best-effort, never a reason to fail. */
async function idFor(response: Response, message: MailMessage): Promise<string> {
  const parsed: unknown = await response.json().catch(() => undefined);
  const id = isRecord(parsed) ? parsed['id'] : undefined;
  if (typeof id === 'string' && id !== '') return id;
  const local = `resend_${nanoid(12)}`;
  logger.warn('mail.resend.no_id', { mailId: message.mailId, id: local });
  return local;
}

interface ResendRequestBody {
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly reply_to?: string;
}

/** `bcc` travels in the body here — Resend builds the envelope, so this is the one place a
 * blind list legitimately leaves the process. Absent fields are omitted, never null: Resend
 * rejects nulls outright. */
function bodyFor(message: MailMessage, from: string): ResendRequestBody {
  return {
    from,
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers: messageHeaders(message),
    ...(message.cc === undefined ? {} : { cc: message.cc }),
    ...(message.bcc === undefined ? {} : { bcc: message.bcc }),
    ...(message.replyTo === undefined ? {} : { reply_to: message.replyTo }),
  };
}

export function createResendDriver(options: ResendDriverOptions): MailDriver {
  const apiKey = requireApiKey(options.apiKey);
  const from = requireFrom(options.from);
  const baseUrl = options.baseUrl ?? RESEND_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // A bare reference to `globalThis.fetch` risks "Illegal invocation" on some hosts; closing
  // over the call keeps it detached from any receiver, in production and in tests alike.
  const doFetch: MailFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  return {
    name: 'resend',

    async send(message: MailMessage): Promise<SendResult> {
      // Always sent, and content-derived rather than taken from the envelope: a job retry after a
      // timeout hands Resend the identical message, and this header is what makes that one email.
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': mailIdempotencyKey(message),
      };

      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/emails`, {
          method: 'POST',
          headers,
          body: JSON.stringify(bodyFor(message, from)),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // DNS/TLS/reset, or the timeout firing — none of them got far enough to have a status,
        // and every one of them can succeed unchanged on the job's next attempt.
        throw sendFailed({
          driver: 'resend',
          stage: 'request',
          detail: error instanceof Error ? error.message : 'the request failed before a response',
          retryable: true,
          fix: `curl -sS ${baseUrl}/emails from this host to confirm egress — the job will retry automatically`,
        });
      }

      if (!response.ok) {
        throw sendFailed({
          driver: 'resend',
          stage: 'request',
          detail: await detailFor(response),
          status: response.status,
          retryable: isRetryableStatus(response.status),
          fix: fixFor(response.status),
        });
      }

      return resultFor('resend', message, await idFor(response, message));
    },
  };
}
