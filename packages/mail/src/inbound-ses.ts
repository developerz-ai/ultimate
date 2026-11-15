// Single responsibility: SES receiving, as an `inboundMail()` provider. A receipt rule's SNS action
// posts the WHOLE message (`content`, raw MIME, UTF8 or BASE64) inside an SNS envelope: the SNS
// signature is proven first (`sns-signature.ts`, the delivery receiver's verifier), then the
// `Received` notification is read. Any other SNS type (a subscription) is the delivery receiver's.

import { type Clock, ConfigInvalidError, finiteCount } from '@ultimat3/core';
import { t, validate } from '@ultimat3/schema';
import { parseDeliveryJson } from './delivery-event';
import { deliveryEventInvalid } from './delivery-event-errors';
import type { MailFetch } from './driver-resend';
import type { InboundDoor, InboundProvider, InboundRow, WebhookInbound } from './inbound-types';
import { bytesOf } from './mime-parse-decode';
import { inboundMalformed, inboundTooLarge } from './mime-parse-errors';
import { DEFAULT_SNS_TOLERANCE_MS, sesEventReceiver } from './ses-event-receiver';
import type { SnsCertificateFetch } from './sns-certificate-cache';
import { snsTopicRegion } from './sns-signature';

export interface SesInboundOptions {
  /** The topic ARNs the receipt rule's SNS action publishes to. Required: SNS signs for anyone. */
  readonly topicArns: readonly string[];
  /** GET a verified SubscriptionConfirmation's SubscribeURL. Off: the subscription stays pending. */
  readonly confirmSubscriptions?: boolean | undefined;
  /** Default `DEFAULT_SNS_TOLERANCE_MS`. */
  readonly toleranceMs?: number | undefined;
  /** The door's body ceiling. Default 1 MiB: SES puts at most 150 KB of content in an SNS action. */
  readonly maxBodyBytes?: number | undefined;
  readonly clock?: Clock | undefined;
  readonly fetchCertificate?: SnsCertificateFetch | undefined;
  readonly fetch?: MailFetch | undefined;
}

const verdict = t.object({ status: t.string }).optional();
const received = t.object({
  notificationType: t.literal('Received'),
  mail: t.object({ messageId: t.string }),
  receipt: t.object({
    recipients: t.array(t.string),
    spamVerdict: verdict,
    virusVerdict: verdict,
    spfVerdict: verdict,
    dkimVerdict: verdict,
    dmarcVerdict: verdict,
    action: t.object({ encoding: t.enum(['UTF8', 'BASE64']).optional() }),
  }),
  content: t.string.optional(),
});

/** The verified envelope, read again for the one field the delivery receiver does not hand back. */
const notification = t.object({ Type: t.literal('Notification'), Message: t.string });

const VERDICTS = ['spam', 'virus', 'spf', 'dkim', 'dmarc'] as const;

/** A verified SNS `Message` → the queue row, or a refusal that names the problem. */
export function sesInboundRow(message: string): {
  readonly eventId: string;
  readonly row: InboundRow;
} {
  const parsed = validate(received, parseDeliveryJson('ses', message));
  if (parsed.issues !== undefined) throw deliveryEventInvalid('ses', 'notification');
  const { mail, receipt, content } = parsed.value;
  if (content === undefined) throw inboundMalformed('content-missing');
  const verdicts: Record<string, string> = {};
  for (const name of VERDICTS) {
    const status = receipt[`${name}Verdict`]?.status;
    if (status !== undefined) verdicts[name] = status;
  }
  return {
    eventId: mail.messageId,
    row: {
      provider: 'ses',
      recipients: receipt.recipients,
      content,
      encoding: receipt.action.encoding ?? 'UTF8',
      verdicts,
    },
  };
}

function rawOf(row: InboundRow, maxBytes: number): Uint8Array {
  if (row.provider !== 'ses') throw inboundMalformed('row');
  // Bounded on the encoded length first: base64 is 4/3 of the bytes, UTF-8 at least 1 per char.
  if (row.content.length > Math.ceil((maxBytes * 4) / 3) + 4)
    throw inboundTooLarge('maxBytes', maxBytes);
  if (row.encoding === 'UTF8') return new TextEncoder().encode(row.content);
  try {
    return bytesOf(atob(row.content.replace(/\s/g, '')));
  } catch {
    throw inboundMalformed('base64');
  }
}

export function sesInbound(options: SesInboundOptions): InboundProvider {
  const topicArns = new Set(options.topicArns);
  if (topicArns.size === 0 || [...topicArns].some((arn) => snsTopicRegion(arn) === undefined)) {
    throw new ConfigInvalidError({
      cause: 'sesInbound needs at least one topic ARN, and every one must be an SNS topic ARN',
      fix: "sesInbound({ topicArns: ['arn:aws:sns:us-east-1:123456789012:inbound-mail'] }) — the topic the receipt rule's SNS action publishes to (aws ses describe-active-receipt-rule-set)",
    });
  }
  const toleranceMs = finiteCount(
    'sesInbound',
    'toleranceMs',
    options.toleranceMs ?? DEFAULT_SNS_TOLERANCE_MS,
    1,
  );
  const maxBodyBytes = finiteCount(
    'sesInbound',
    'maxBodyBytes',
    options.maxBodyBytes ?? 1_048_576,
    1,
  );
  // ONE verifier: the delivery receiver proves the SNS signature over these exact bytes (and owns
  // the SubscriptionConfirmation protocol); only then is the same body read for its `Message`.
  const verifier = sesEventReceiver({
    topicArns: [...topicArns],
    confirmSubscriptions: options.confirmSubscriptions,
    toleranceMs,
    maxBytes: maxBodyBytes,
    clock: options.clock,
    fetchCertificate: options.fetchCertificate,
    fetch: options.fetch,
  });

  return {
    name: 'ses',
    maxBodyBytes,
    async door(inbound: WebhookInbound): Promise<InboundDoor> {
      const outcome = await verifier.receive(inbound.request());
      if (outcome.type === 'subscription') {
        return { answer: Response.json({ ok: true, confirmed: outcome.confirmed }) };
      }
      const envelope = validate(
        notification,
        parseDeliveryJson('ses', new TextDecoder().decode(inbound.bytes)),
      );
      if (envelope.issues !== undefined) {
        // Verified and not a Notification: an UnsubscribeConfirmation. Nothing to queue.
        return { answer: Response.json({ ok: true }) };
      }
      return sesInboundRow(envelope.value.Message);
    },
    async mime(row, maxBytes) {
      return rawOf(row, maxBytes);
    },
  };
}
