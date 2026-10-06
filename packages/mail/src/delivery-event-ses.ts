// Single responsibility: an Amazon SES notification — the JSON inside a VERIFIED SNS message —
// becomes `DeliveryEvent`s. Both SES spellings are read: identity notifications
// (`notificationType`) and configuration-set event publishing (`eventType`). Verification and the
// HTTP side are `ses-event-receiver.ts`; this file trusts its input and only translates it.

import { t, validate } from '@ultimat3/schema';
import {
  type DeliveryEvent,
  type DeliveryOutcome,
  deliveryInstant,
  parseDeliveryJson,
} from './delivery-event';
import { deliveryEventInvalid } from './delivery-event-errors';

const recipient = t.object({ emailAddress: t.string });

/** Per event type: the sub-object SES nests it in, its recipient list, and the kind it becomes. */
const SES_TYPES = {
  Bounce: t.object({
    bounce: t.object({
      bounceType: t.string,
      bouncedRecipients: t.array(recipient),
      timestamp: t.string,
    }),
  }),
  Complaint: t.object({
    complaint: t.object({ complainedRecipients: t.array(recipient), timestamp: t.string }),
  }),
  Delivery: t.object({
    delivery: t.object({ recipients: t.array(t.string), timestamp: t.string }),
  }),
  DeliveryDelay: t.object({
    deliveryDelay: t.object({ delayedRecipients: t.array(recipient), timestamp: t.string }),
  }),
} as const;

const notificationHead = t.object({
  notificationType: t.string.optional(),
  eventType: t.string.optional(),
  mail: t.object({ messageId: t.string }).optional(),
});

type Row = { readonly recipient: string; readonly at: string };

/** SES's notification JSON (the SNS `Message`) → events; a type this does not model is ignored. */
export function sesDeliveryEvents(message: string, eventId: string): DeliveryOutcome {
  const raw = parseDeliveryJson('ses', message);
  const head = validate(notificationHead, raw);
  if (head.issues !== undefined) throw deliveryEventInvalid('ses', 'notification');
  const eventType = head.value.notificationType ?? head.value.eventType ?? '';
  const messageId = head.value.mail?.messageId;
  const base = (row: Row) => ({
    provider: 'ses' as const,
    messageId: messageId ?? '',
    recipient: row.recipient,
    at: deliveryInstant('ses', row.at),
    eventId,
    raw,
  });
  const read = <S extends (typeof SES_TYPES)[keyof typeof SES_TYPES]>(schema: S) => {
    const parsed = validate(schema, raw);
    if (parsed.issues !== undefined || messageId === undefined) {
      throw deliveryEventInvalid('ses', 'notification');
    }
    return parsed.value;
  };

  let events: DeliveryEvent[];
  if (eventType === 'Bounce') {
    const { bounce } = read(SES_TYPES.Bounce);
    // `Undetermined` is soft: suppressing an address on a verdict SES itself could not reach
    // loses a real recipient, and a hard bounce, if it is one, arrives as `Permanent` next time.
    const kind = bounce.bounceType === 'Permanent' ? 'hard' : 'soft';
    events = bounce.bouncedRecipients.map((r) => ({
      ...base({ recipient: r.emailAddress, at: bounce.timestamp }),
      kind: 'bounced',
      bounce: kind,
    }));
  } else if (eventType === 'Complaint') {
    const { complaint } = read(SES_TYPES.Complaint);
    events = complaint.complainedRecipients.map((r) => ({
      ...base({ recipient: r.emailAddress, at: complaint.timestamp }),
      kind: 'complained',
    }));
  } else if (eventType === 'Delivery') {
    const { delivery } = read(SES_TYPES.Delivery);
    events = delivery.recipients.map((address) => ({
      ...base({ recipient: address, at: delivery.timestamp }),
      kind: 'delivered',
    }));
  } else if (eventType === 'DeliveryDelay') {
    const { deliveryDelay } = read(SES_TYPES.DeliveryDelay);
    events = deliveryDelay.delayedRecipients.map((r) => ({
      ...base({ recipient: r.emailAddress, at: deliveryDelay.timestamp }),
      kind: 'delayed',
    }));
  } else {
    return { type: 'ignored', eventType: eventType === '' ? 'unknown' : eventType };
  }
  return { type: 'events', events };
}
