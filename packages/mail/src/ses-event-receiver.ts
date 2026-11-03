// Single responsibility: the `api/` route half of SES delivery notifications. Read the capped
// body, prove SNS signed it for one of this app's topics (`sns-signature.ts`), then hand the
// notification to `delivery-event-ses.ts`. A SubscriptionConfirmation is answered with its confirm
// URL, and that URL is fetched only when the receiver was built with `confirmSubscriptions: true`.

import {
  type Clock,
  ConfigInvalidError,
  finiteCount,
  isUltimateError,
  renderThrowable,
} from '@ultimat3/core';
import { outbound } from '@ultimat3/core/outbound';
import {
  type DeliveryOutcome,
  type DeliveryReceiver,
  parseDeliveryJson,
  readDeliveryBody,
  resolveBodyLimit,
} from './delivery-event';
import { deliveryEventInvalid, deliveryProviderUnreachable } from './delivery-event-errors';
import { sesDeliveryEvents } from './delivery-event-ses';
import type { MailFetch } from './driver-resend';
import { createSnsCertificateCache } from './sns-certificate-cache';
import {
  isPinnedSubscribeUrl,
  type SnsCertificateFetch,
  type SnsMessage,
  snsTopicRegion,
  verifySnsMessage,
} from './sns-signature';

/**
 * One hour, either way. SNS's default HTTP retry policy redelivers within a minute; a custom
 * delivery policy can stretch that, and `toleranceMs` is the knob for a topic that does.
 */
export const DEFAULT_SNS_TOLERANCE_MS = 3_600_000;

const PROVIDER_TIMEOUT_MS = 5_000;
const CERTIFICATE_MAX_BYTES = 16_384;

export interface SesEventReceiverOptions {
  /** The topic ARNs this route is subscribed to. Required: SNS signs for ANY account's topic. */
  readonly topicArns: readonly string[];
  /** GET the SubscribeURL of a verified SubscriptionConfirmation. Off: the URL is returned. */
  readonly confirmSubscriptions?: boolean | undefined;
  /** Default `DEFAULT_SNS_TOLERANCE_MS`. */
  readonly toleranceMs?: number | undefined;
  /** Default `DEFAULT_DELIVERY_BODY_LIMIT`. */
  readonly maxBytes?: number | undefined;
  readonly clock?: Clock | undefined;
  /** Certificate download. Default: a GET over pinned https, no redirects, 5 s, 16 KiB. */
  readonly fetchCertificate?: SnsCertificateFetch | undefined;
  /** The subscription-confirm GET, and the default certificate download. Default: global fetch. */
  readonly fetch?: MailFetch | undefined;
}

/**
 * Why an `outbound()` call to SNS got no usable answer, in this receiver's own words, or the
 * error itself when it is not outbound's (a caller's abort keeps its meaning). `dial: 'named'`:
 * both URLs were already pinned to `sns.<region>.amazonaws.com` before this is reached.
 */
function providerReason(error: unknown): string {
  if (!isUltimateError(error) || !error.code.startsWith('X_OUTBOUND_')) throw error;
  if (error.code === 'X_OUTBOUND_TOO_LARGE') return 'the answer was too large';
  const status = error.meta?.['status'];
  return typeof status === 'number' ? `HTTP ${status}` : renderThrowable(error);
}

/** The default download: pinned https, no redirect (a redirect would leave the pinned host). */
function defaultCertificateFetch(fetch: MailFetch): SnsCertificateFetch {
  return async (url) => {
    try {
      const answer = await outbound(
        {
          url,
          vendor: 'sns',
          dial: 'named',
          deadlineMs: PROVIDER_TIMEOUT_MS,
          maxBytes: CERTIFICATE_MAX_BYTES,
        },
        { fetch },
      );
      return answer.text();
    } catch (error) {
      throw deliveryProviderUnreachable('certificate', providerReason(error));
    }
  };
}

export function sesEventReceiver(options: SesEventReceiverOptions): DeliveryReceiver {
  const topicArns = new Set(options.topicArns);
  if (topicArns.size === 0 || [...topicArns].some((arn) => snsTopicRegion(arn) === undefined)) {
    throw deliveryEventConfig();
  }
  const maxBytes = resolveBodyLimit('sesEventReceiver', options.maxBytes);
  const toleranceMs = finiteCount(
    'sesEventReceiver',
    'toleranceMs',
    options.toleranceMs ?? DEFAULT_SNS_TOLERANCE_MS,
    1,
  );
  // `outbound()` always hands it the attempt's signal.
  const doFetch: MailFetch =
    options.fetch ??
    ((input, init) => globalThis.fetch(input, { ...init, signal: init.signal ?? null }));
  const verify = {
    topicArns,
    toleranceMs,
    clock: options.clock,
    certificates: createSnsCertificateCache({
      fetchCertificate: options.fetchCertificate ?? defaultCertificateFetch(doFetch),
      clock: options.clock,
    }),
  };

  return {
    async receive(request) {
      const body = await readDeliveryBody('ses', request, maxBytes);
      const message = await verifySnsMessage(parseDeliveryJson('ses', body), verify);
      if (message.Type === 'Notification')
        return sesDeliveryEvents(message.Message, message.MessageId);
      if (message.Type === 'UnsubscribeConfirmation') {
        return { type: 'ignored', eventType: 'UnsubscribeConfirmation' };
      }
      return await subscription(message);
    },
  };

  async function subscription(message: SnsMessage): Promise<DeliveryOutcome> {
    const confirmUrl = message.SubscribeURL ?? '';
    const region = snsTopicRegion(message.TopicArn) ?? '';
    // Signed, and pinned anyway: the URL is fetched by THIS host when confirming is on.
    if (!isPinnedSubscribeUrl(confirmUrl, region)) throw deliveryEventInvalid('ses', 'envelope');
    if (options.confirmSubscriptions !== true) {
      return { type: 'subscription', topicArn: message.TopicArn, confirmUrl, confirmed: false };
    }
    try {
      await outbound(
        { url: confirmUrl, vendor: 'sns', dial: 'named', deadlineMs: PROVIDER_TIMEOUT_MS },
        { fetch: doFetch },
      );
    } catch (error) {
      throw deliveryProviderUnreachable('subscription', providerReason(error));
    }
    return { type: 'subscription', topicArn: message.TopicArn, confirmUrl, confirmed: true };
  }
}

function deliveryEventConfig(): ConfigInvalidError {
  return new ConfigInvalidError({
    cause: 'sesEventReceiver needs at least one topic ARN, and every one must be an SNS topic ARN',
    fix: "sesEventReceiver({ topicArns: ['arn:aws:sns:us-east-1:123456789012:ses-events'] }) — the topics this route is subscribed to (aws sns list-topics)",
  });
}
