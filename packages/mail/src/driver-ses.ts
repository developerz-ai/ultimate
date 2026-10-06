// Single responsibility: the Amazon SES transport. One SES v2 `SendEmail` per message, the body
// the raw MIME `mime.ts` builds, signed with core's one SigV4 signer and sent over `fetch` — no
// SDK. Construction refuses a missing credential, an unusable region or a bad endpoint, so a
// misconfiguration never waits for the first send.

import {
  type AwsCredentials,
  type Clock,
  ConfigInvalidError,
  EnvMissingError,
  finiteCount,
  isUltimateError,
  nanoid,
  renderFixShellArg,
  renderThrowable,
  signAwsRequest,
  systemClock,
} from '@ultimat3/core';
import { base64Utf8 } from './base64';
import type { MailDriver, MailMessage, SendResult } from './driver';
import { resultFor } from './driver';
import type { MailFetch } from './driver-resend';
import { sendFailed } from './errors';
import { mailMessageIdToken } from './idempotency';
import { addressDomain, buildMimeMessage } from './mime';
import { type RetainMimeOptions, resolveRetainMime, withRetainedMime } from './retain-mime';
import { sesFailure } from './ses-failure';

const DEFAULT_TIMEOUT_MS = 15_000;
const SEND_PATH = '/v2/email/outbound-emails';
/** `us-east-1`, `eu-west-2`, `us-gov-west-1` — what AWS calls a region, and nothing a URL could hide in. */
const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;

export interface SesDriverOptions {
  /** Read from `SES_REGION`. The endpoint is `https://email.<region>.amazonaws.com`. */
  readonly region: string;
  /** Read from `SES_ACCESS_KEY_ID` / `SES_SECRET_ACCESS_KEY` (/ `SES_SESSION_TOKEN`). */
  readonly credentials: AwsCredentials;
  /** `Postly <no-reply@postly.test>`. Must be an identity verified in this region. */
  readonly from: string;
  /** A VPC endpoint or a local stand-in. Defaults to the region's public endpoint. */
  readonly endpoint?: string | undefined;
  /** `ConfigurationSetName` — the set whose event destination publishes Bounce/Complaint/Delivery. */
  readonly configurationSet?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly clock?: Clock | undefined;
  /** Keep the exact MIME of every accepted send on `SendResult.mime` and hand it to `onRetained`. */
  readonly retainMime?: RetainMimeOptions | undefined;
  /** Injected in tests; production uses the global. */
  readonly fetch?: MailFetch | undefined;
}

export const sesEndpoint = (region: string): string => `https://email.${region}.amazonaws.com`;

function requireRegion(region: string): string {
  if (REGION.test(region)) return region;
  throw new ConfigInvalidError({
    cause:
      'SES_REGION is not an AWS region name, so no SES endpoint or signing scope exists for it',
    fix: 'SES_REGION=us-east-1 — the region your sending identity is verified in',
    meta: { key: 'SES_REGION' },
  });
}

function requireCredentials(credentials: AwsCredentials): AwsCredentials {
  const missing = [
    ...(credentials.accessKeyId.trim() === '' ? ['SES_ACCESS_KEY_ID'] : []),
    ...(credentials.secretAccessKey.trim() === '' ? ['SES_SECRET_ACCESS_KEY'] : []),
  ];
  if (missing.length === 0) return credentials;
  throw new EnvMissingError({
    cause: `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set, so the ses driver cannot sign a request`,
    fix: "SES_ACCESS_KEY_ID=<key id> SES_SECRET_ACCESS_KEY=<secret> — in .env or the container's secret store, then re-run",
    meta: { missing },
  });
}

function requireEndpoint(endpoint: string): string {
  const url = URL.parse(endpoint);
  if (
    url !== null &&
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.search === ''
  ) {
    return url.origin;
  }
  throw new ConfigInvalidError({
    cause: 'SES_ENDPOINT is not an http(s) origin, so no SendEmail URL can be built from it',
    fix: 'SES_ENDPOINT=https://email.us-east-1.amazonaws.com — or unset it for the region default',
    meta: { key: 'SES_ENDPOINT' },
  });
}

function requireFrom(from: string): string {
  if (from.trim() !== '') return from;
  throw new ConfigInvalidError({
    cause: 'the ses driver was configured without a from address',
    fix: 'aws sesv2 list-email-identities — then set MAIL_FROM to one verified in this region',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `Destination` is the envelope, and it is sent even though the raw message holds `To:` and `Cc:`
 * — `Bcc` is never a header (`mime.ts`), so without it the blind list would receive nothing.
 */
function bodyFor(message: MailMessage, from: string, raw: string, set: string | undefined): string {
  return JSON.stringify({
    FromEmailAddress: from,
    Destination: {
      ToAddresses: message.to,
      ...(message.cc === undefined ? {} : { CcAddresses: message.cc }),
      ...(message.bcc === undefined ? {} : { BccAddresses: message.bcc }),
    },
    Content: { Raw: { Data: base64Utf8(raw) } },
    ...(set === undefined ? {} : { ConfigurationSetName: set }),
  });
}

export function createSesDriver(options: SesDriverOptions): MailDriver {
  const region = requireRegion(options.region);
  const credentials = requireCredentials(options.credentials);
  const from = requireFrom(options.from);
  const origin = requireEndpoint(options.endpoint ?? sesEndpoint(region));
  const timeoutMs = finiteCount(
    'createSesDriver',
    'timeoutMs',
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    1,
  );
  const retain = resolveRetainMime('createSesDriver', options.retainMime);
  const clock = options.clock ?? systemClock;
  const doFetch: MailFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  return { name: 'ses', send };

  async function send(message: MailMessage): Promise<SendResult> {
    // Content-derived like SMTP's, so every attempt presents one id. SES rewrites `Message-ID` to
    // its own on the way out, and SES has no idempotency header: a retry after a timeout that SES
    // had in fact accepted is a second email. That is SMTP's gap, not Resend's guarantee.
    const raw = buildMimeMessage(message, {
      from,
      messageId: `<${message.mailId}.${mailMessageIdToken(message)}@${addressDomain(from)}>`,
      date: clock.now(),
      boundary: `x-ultimate-${nanoid(20)}`,
    });
    const body = bodyFor(message, from, raw, options.configurationSet);

    let response: Response;
    try {
      const signed = await signAwsRequest({
        method: 'POST',
        url: `${origin}${SEND_PATH}`,
        headers: { 'content-type': 'application/json' },
        payload: { body },
        credentials,
        region,
        service: 'ses',
        clock,
      });
      response = await doFetch(signed.url, {
        method: 'POST',
        headers: signed.headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // The signer's own refusals are coded and say which input to fix; only the network is left.
      if (isUltimateError(error)) throw error;
      throw sendFailed({
        driver: 'ses',
        stage: 'request',
        detail: `${renderThrowable(error)} — nothing left this host for ${origin}${SEND_PATH} (egress, DNS or TLS)`,
        retryable: true,
        fix: `curl -sS -m 5 -o /dev/null ${renderFixShellArg(origin, '<SES endpoint>')}/`,
      });
    }

    if (!response.ok) {
      const failure = await sesFailure(response, region);
      throw sendFailed({
        driver: 'ses',
        stage: 'request',
        detail: failure.detail,
        status: response.status,
        retryable: failure.retryable,
        fix: failure.fix,
      });
    }

    const parsed: unknown = await response.json().catch(() => undefined);
    const id = isRecord(parsed) ? parsed['MessageId'] : undefined;
    // A 2xx is acceptance. The id is what SNS notifications name the message by, so a local one
    // is a correlation lost — but never a reason to report an accepted send as failed.
    const result = resultFor(
      'ses',
      message,
      typeof id === 'string' && id !== '' ? id : `ses_${nanoid(12)}`,
    );
    return await withRetainedMime(retain, result, message.mailId, raw);
  }
}
