// Single responsibility: the public API of `@ultimat3/mail/events` — the delivery-notification
// receivers and their verification. A subpath and not the barrel because only an app's webhook
// route uses them, and every serving role (worker, scheduler, migrate) loads the barrel to send.

export type {
  DeliveryEvent,
  DeliveryEventKind,
  DeliveryOutcome,
  DeliveryReceiver,
} from './delivery-event';
export { DEFAULT_DELIVERY_BODY_LIMIT } from './delivery-event';
export type {
  DeliveryProvider,
  DeliveryRefusal,
  DeliveryShapeProblem,
  ResendRefusal,
} from './delivery-event-errors';
export {
  deliveryEventInvalid,
  deliveryEventUnverified,
  deliveryProviderUnreachable,
} from './delivery-event-errors';
export type { ResendEventReceiverOptions } from './resend-event-receiver';
export { resendEventReceiver } from './resend-event-receiver';
export { DEFAULT_SVIX_TOLERANCE_MS } from './resend-signature';
export type { SesEventReceiverOptions } from './ses-event-receiver';
export { DEFAULT_SNS_TOLERANCE_MS, sesEventReceiver } from './ses-event-receiver';
export type { SnsCertificateFetch } from './sns-certificate-cache';
