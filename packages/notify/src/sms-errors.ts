// Single responsibility: the SMS seam's two refusals. Registered and classified with the rest of the
// package's codes in `errors.ts`. No cause ever carries a phone number or a message body: both are
// a person's, and a cause lands in logs, traces and the dead-letter row.

import { UltimateError } from '@ultimat3/core';
// Bare: the titles these codes render with, and their retry classification, are registered there.
import './errors';

/** No transport installed, outside development and test — where the memory one stands in. */
export class NotifySmsTransportMissingError extends UltimateError {
  constructor() {
    super({
      code: 'X_NOTIFY_SMS_TRANSPORT_MISSING',
      cause:
        'an SMS was sent with no SmsTransport installed: outside development and test the memory transport would swallow the message, so the send is refused',
      fix: 'smsTransport: yourTransport(),   # in apps/<app>/runtime.ts — behavesLike(smsTransportConformance, () => yourTransport()) from @ultimat3/testing/conformance proves it',
    });
  }
}

/** A number that is not E.164. The number itself stays out of the cause: `meta.recipient` names whose. */
export class NotifySmsNumberInvalidError extends UltimateError {
  constructor(input: { readonly recipient: string | undefined }) {
    super({
      code: 'X_NOTIFY_SMS_NUMBER_INVALID',
      cause:
        'an SMS number is not E.164 (+, a country code, at most 15 digits in all): a local spelling is a number a provider guesses the country of',
      fix: "smsChannel({ numberOf: (recipient) => recipient.to })   # answering E.164 ('+4915112345678'): store numbers that way",
      ...(input.recipient === undefined ? {} : { meta: { recipient: input.recipient } }),
    });
  }
}
