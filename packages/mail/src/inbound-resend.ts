// Single responsibility: Resend receiving, as an `inboundMail()` provider. The `email.received`
// webhook is Svix-signed (`resend-signature.ts`, proven before any parse) and carries metadata
// only, so the door queues the email id; the job then reads the message from Resend's API and
// downloads its raw MIME — one parser for every provider, never Resend's pre-parsed JSON.

import { type Clock, ConfigInvalidError, finiteCount, isUltimateError } from '@ultimat3/core';
import { type DialResolve, outbound } from '@ultimat3/core/outbound';
import { t, validate } from '@ultimat3/schema';
import { parseDeliveryJson } from './delivery-event';
import { deliveryEventInvalid } from './delivery-event-errors';
import type { MailFetch } from './driver-resend';
import type { InboundDoor, InboundProvider, InboundRow, WebhookInbound } from './inbound-types';
import { inboundMalformed, inboundTooLarge } from './mime-parse-errors';
import {
  DEFAULT_SVIX_TOLERANCE_MS,
  svixKey,
  svixSecretBytes,
  verifySvix,
} from './resend-signature';

export const RESEND_API_ORIGIN = 'https://api.resend.com';
const DEADLINE_MS = 30_000;
/** Resend's ids are UUIDs; anything else never reaches a URL. */
const EMAIL_ID = /^[A-Za-z0-9-]{1,128}$/;

export interface ResendInboundOptions {
  /** The receiving webhook's `whsec_…` signing secret. Never logged. */
  readonly secret: string;
  /** A Resend API key with receiving access, for `GET /emails/receiving/:id`. Never logged. */
  readonly apiKey: string;
  /** Default `DEFAULT_SVIX_TOLERANCE_MS`. */
  readonly toleranceMs?: number | undefined;
  readonly clock?: Clock | undefined;
  /** Both GETs. Default: the platform fetch, through core's `outbound()`. */
  readonly fetch?: MailFetch | undefined;
  /** The raw download's host is Resend's choice, so it is a public dial: screened and pinned. */
  readonly resolve?: DialResolve | undefined;
}

const webhook = t.object({
  type: t.string,
  data: t
    .object({
      email_id: t.string,
      to: t.array(t.string),
      received_for: t.array(t.string).optional(),
    })
    .optional(),
});

const receivedEmail = t.object({
  raw: t.object({ download_url: t.url }).nullable().optional(),
});

const decoder = new TextDecoder('utf-8', { fatal: true });

/** `X_OUTBOUND_TOO_LARGE` is the message's bound, in this receiver's words; the rest pass through. */
function sized(error: unknown, maxBytes: number): unknown {
  return isUltimateError(error) && error.code === 'X_OUTBOUND_TOO_LARGE'
    ? inboundTooLarge('maxBytes', maxBytes)
    : error;
}

export function resendInbound(options: ResendInboundOptions): InboundProvider {
  const secret = svixSecretBytes(options.secret);
  if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
    throw new ConfigInvalidError({
      cause: 'resendInbound has no Resend API key, and the webhook carries no message body',
      fix: 'resendInbound({ secret: env.RESEND_WEBHOOK_SECRET, apiKey: env.RESEND_API_KEY }) — a key from https://resend.com/api-keys with receiving access',
    });
  }
  const toleranceMs = finiteCount(
    'resendInbound',
    'toleranceMs',
    options.toleranceMs ?? DEFAULT_SVIX_TOLERANCE_MS,
    1,
  );
  let key: Promise<CryptoKey> | undefined;
  const deps = { fetch: options.fetch, resolve: options.resolve };

  return {
    name: 'resend',
    async door(inbound: WebhookInbound): Promise<InboundDoor> {
      let body: string;
      try {
        body = decoder.decode(inbound.bytes);
      } catch {
        throw deliveryEventInvalid('resend', 'not-utf8');
      }
      key ??= svixKey(secret);
      await verifySvix(
        {
          id: inbound.headers.get('svix-id'),
          timestamp: inbound.headers.get('svix-timestamp'),
          signature: inbound.headers.get('svix-signature'),
        },
        body,
        { key: await key, toleranceMs, clock: options.clock },
      );
      const parsed = validate(webhook, parseDeliveryJson('resend', body));
      if (parsed.issues !== undefined) throw deliveryEventInvalid('resend', 'envelope');
      const { type, data } = parsed.value;
      // Authentic, and not a received email (a delivery event on the same endpoint): no row.
      if (type !== 'email.received') return { answer: Response.json({ ok: true, ignored: type }) };
      if (data === undefined || !EMAIL_ID.test(data.email_id)) {
        throw deliveryEventInvalid('resend', 'notification');
      }
      const forwarded = data.received_for ?? [];
      const row: InboundRow = {
        provider: 'resend',
        recipients: forwarded.length > 0 ? forwarded : data.to,
        emailId: data.email_id,
      };
      return { eventId: data.email_id, row };
    },
    async mime(row, maxBytes) {
      if (row.provider !== 'resend') throw inboundMalformed('row');
      const email = await outbound(
        {
          url: `${RESEND_API_ORIGIN}/emails/receiving/${row.emailId}`,
          vendor: 'resend',
          dial: 'named',
          deadlineMs: DEADLINE_MS,
          headers: { authorization: `Bearer ${options.apiKey}`, accept: 'application/json' },
          // The JSON repeats html and text beside the raw link: bounded by the message's own bound.
          maxBytes: maxBytes * 3,
        },
        deps,
      ).catch((error: unknown) => Promise.reject(sized(error, maxBytes)));
      const download = email.json(receivedEmail).raw?.download_url;
      if (download === undefined) throw inboundMalformed('raw-unavailable');
      // A signed URL: the API key never travels to it.
      const raw = await outbound(
        { url: download, vendor: 'resend-raw', dial: 'public', deadlineMs: DEADLINE_MS, maxBytes },
        deps,
      ).catch((error: unknown) => Promise.reject(sized(error, maxBytes)));
      return raw.bytes;
    },
  };
}
