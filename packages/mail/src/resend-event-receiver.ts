// Single responsibility: a Resend webhook, received by an `api/` route, becomes `DeliveryEvent`s.
// The Svix signature is proven first (`resend-signature.ts`) over the exact bytes that arrived;
// only then is the body parsed. `email.delivered`, `email.bounced`, `email.complained` and
// `email.delivery_delayed` are modelled; every other type is authentic and `ignored`.

import { type Clock, finiteCount } from '@ultimat3/core';
import { t, validate } from '@ultimat3/schema';
import {
  type DeliveryEvent,
  type DeliveryOutcome,
  type DeliveryReceiver,
  deliveryInstant,
  parseDeliveryJson,
  readDeliveryBody,
  resolveBodyLimit,
} from './delivery-event';
import { deliveryEventInvalid } from './delivery-event-errors';
import {
  DEFAULT_SVIX_TOLERANCE_MS,
  svixKey,
  svixSecretBytes,
  verifySvix,
} from './resend-signature';

export interface ResendEventReceiverOptions {
  /** The endpoint's `whsec_…` signing secret, from `RESEND_WEBHOOK_SECRET`. Never logged. */
  readonly secret: string;
  /** Default `DEFAULT_SVIX_TOLERANCE_MS`. */
  readonly toleranceMs?: number | undefined;
  /** Default `DEFAULT_DELIVERY_BODY_LIMIT`. */
  readonly maxBytes?: number | undefined;
  readonly clock?: Clock | undefined;
}

const payload = t.object({
  type: t.string,
  created_at: t.string,
  data: t.object({
    email_id: t.string,
    to: t.array(t.string),
    bounce: t.object({ type: t.string.optional() }).optional(),
  }),
});

/** A Map: `type` is the webhook body's, and `{ type: 'constructor' }` must be ignored, not mapped. */
const KINDS: ReadonlyMap<string, DeliveryEvent['kind']> = new Map<string, DeliveryEvent['kind']>([
  ['email.delivered', 'delivered'],
  ['email.bounced', 'bounced'],
  ['email.complained', 'complained'],
  ['email.delivery_delayed', 'delayed'],
]);

/**
 * A verified Resend payload → events. Resend names no single bounced address, so a multi-recipient
 * email's bounce is one event per `to` — send one recipient per email to know which one it was.
 */
export function resendDeliveryEvents(raw: unknown, eventId: string): DeliveryOutcome {
  const head = validate(t.object({ type: t.string }), raw);
  if (head.issues !== undefined) throw deliveryEventInvalid('resend', 'envelope');
  const kind = KINDS.get(head.value.type);
  if (kind === undefined) return { type: 'ignored', eventType: head.value.type };
  const parsed = validate(payload, raw);
  if (parsed.issues !== undefined) throw deliveryEventInvalid('resend', 'notification');
  const { data } = parsed.value;
  const at = deliveryInstant('resend', parsed.value.created_at);
  // Resend relays SES's verdict: `Permanent` is hard; `Transient` and `Undetermined` are soft.
  const bounce = data.bounce?.type === 'Permanent' ? 'hard' : 'soft';
  const events = data.to.map((recipient): DeliveryEvent => {
    const base = {
      provider: 'resend' as const,
      messageId: data.email_id,
      recipient,
      at,
      eventId,
      raw,
    };
    return kind === 'bounced' ? { ...base, kind, bounce } : { ...base, kind };
  });
  return { type: 'events', events };
}

export function createResendEventReceiver(options: ResendEventReceiverOptions): DeliveryReceiver {
  // The shape is refused HERE, at boot; only the Web Crypto import waits for the first delivery.
  const secret = svixSecretBytes(options.secret);
  let key: Promise<CryptoKey> | undefined;
  const maxBytes = resolveBodyLimit('createResendEventReceiver', options.maxBytes);
  const toleranceMs = finiteCount(
    'createResendEventReceiver',
    'toleranceMs',
    options.toleranceMs ?? DEFAULT_SVIX_TOLERANCE_MS,
    1,
  );

  return {
    async receive(request) {
      const body = await readDeliveryBody('resend', request, maxBytes);
      const headers = {
        id: request.headers.get('svix-id'),
        timestamp: request.headers.get('svix-timestamp'),
        signature: request.headers.get('svix-signature'),
      };
      key ??= svixKey(secret);
      const { eventId } = await verifySvix(headers, body, {
        key: await key,
        toleranceMs,
        clock: options.clock,
      });
      return resendDeliveryEvents(parseDeliveryJson('resend', body), eventId);
    },
  };
}
