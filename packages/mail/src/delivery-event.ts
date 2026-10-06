// Single responsibility: the ONE shape a provider's delivery notification becomes, and the reads
// both receivers share — the capped body, the JSON parse, the ISO instant. What a provider calls a
// bounce or a complaint is translated in its own file; what the APP does with one (suppress the
// address, flag the account) is the app's, and nothing here decides it.

import { finiteCount, readWithinLimit } from '@ultimat3/core';
import { isIsoDateTime } from '@ultimat3/schema';
import { type DeliveryProvider, deliveryEventInvalid } from './delivery-event-errors';

/** SNS caps a message at 256 KiB and JSON-escapes it once more inside its envelope. */
export const DEFAULT_DELIVERY_BODY_LIMIT = 1_048_576;

interface DeliveryEventBase {
  readonly provider: DeliveryProvider;
  /**
   * The provider's id for the MESSAGE — `SendResult.id` from the driver that sent it (the SES
   * `MessageId`, the Resend email id), so a notification joins the send it is about.
   */
  readonly messageId: string;
  /** One recipient per event: a bounce naming three addresses is three events. */
  readonly recipient: string;
  /** When the provider says it happened — never when it reached this route. */
  readonly at: Date;
  /**
   * The provider's id for the NOTIFICATION (SNS `MessageId`, `svix-id`), signed. With
   * `recipient` it is the dedupe key: a provider redelivers, and a replay inside the window
   * verifies again by design.
   */
  readonly eventId: string;
  /** The verified notification as the provider sent it, parsed — every field this type drops. */
  readonly raw: unknown;
}

export type DeliveryEvent =
  | (DeliveryEventBase & { readonly kind: 'delivered' })
  | (DeliveryEventBase & {
      readonly kind: 'bounced';
      /** `hard`: the address does not exist or refuses — stop sending. `soft`: it may clear. */
      readonly bounce: 'hard' | 'soft';
    })
  | (DeliveryEventBase & { readonly kind: 'complained' })
  | (DeliveryEventBase & { readonly kind: 'delayed' });

export type DeliveryEventKind = DeliveryEvent['kind'];

/** What a receiver answers. Every variant is a VERIFIED notification; a forgery is a throw. */
export type DeliveryOutcome =
  | { readonly type: 'events'; readonly events: readonly DeliveryEvent[] }
  /** Authentic, of a type this normaliser does not model (`email.opened`, an SES `Send`). */
  | { readonly type: 'ignored'; readonly eventType: string }
  /**
   * An SNS `SubscriptionConfirmation`. `confirmed` is true only when the receiver was built with
   * `confirmSubscriptions: true` and the confirm request succeeded; otherwise visit `confirmUrl`.
   */
  | {
      readonly type: 'subscription';
      readonly topicArn: string;
      readonly confirmUrl: string;
      readonly confirmed: boolean;
    };

export interface DeliveryReceiver {
  /** Verify, then normalise. Read the request once — its body is spent afterwards. */
  receive(request: Request): Promise<DeliveryOutcome>;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/** The body as text, through core's counting reader so an oversized one is never held whole. */
export async function readDeliveryBody(
  provider: DeliveryProvider,
  request: Request,
  maxBytes: number,
): Promise<string> {
  const read = await readWithinLimit(request.body, maxBytes);
  if ('over' in read) throw deliveryEventInvalid(provider, 'too-large');
  try {
    return decoder.decode(read.bytes);
  } catch {
    throw deliveryEventInvalid(provider, 'not-utf8');
  }
}

export function parseDeliveryJson(provider: DeliveryProvider, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw deliveryEventInvalid(provider, 'not-json');
  }
}

/** An ISO-8601 instant with its offset, or a refusal — `new Date('garbage')` is not one. */
export function deliveryInstant(provider: DeliveryProvider, value: string): Date {
  const at = isIsoDateTime(value) ? new Date(value) : undefined;
  if (at === undefined || Number.isNaN(at.getTime())) {
    throw deliveryEventInvalid(provider, 'timestamp');
  }
  return at;
}

export function resolveBodyLimit(subject: string, maxBytes: number | undefined): number {
  return finiteCount(subject, 'maxBytes', maxBytes ?? DEFAULT_DELIVERY_BODY_LIMIT, 1);
}
