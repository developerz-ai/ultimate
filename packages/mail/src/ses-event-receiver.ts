// Single responsibility: the `api/` route half of SES delivery notifications. Read the capped
// body, prove SNS signed it for one of this app's topics (`sns-signature.ts`), then hand the
// notification to `delivery-event-ses.ts`. A SubscriptionConfirmation is answered with its confirm
// URL, and that URL is fetched only when the receiver was built with `confirmSubscriptions: true`.

import {
  type Clock,
  ConfigInvalidError,
  finiteCount,
  readWithinLimit,
  renderThrowable,
} from '@ultimat3/core';
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
import {
  isPinnedSnsUrl,
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

/** The default download: pinned https, no redirect (a redirect would leave the pinned host). */
function defaultCertificateFetch(fetch: MailFetch): SnsCertificateFetch {
  return async (url) => {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw deliveryProviderUnreachable('certificate', `HTTP ${response.status}`);
    }
    const read = await readWithinLimit(response.body, CERTIFICATE_MAX_BYTES);
    if ('over' in read)
      throw deliveryProviderUnreachable('certificate', 'the answer was too large');
    return new TextDecoder().decode(read.bytes);
  };
}

export function createSesEventReceiver(options: SesEventReceiverOptions): DeliveryReceiver {
  const topicArns = new Set(options.topicArns);
  if (topicArns.size === 0 || [...topicArns].some((arn) => snsTopicRegion(arn) === undefined)) {
    throw deliveryEventConfig();
  }
  const maxBytes = resolveBodyLimit('createSesEventReceiver', options.maxBytes);
  const toleranceMs = finiteCount(
    'createSesEventReceiver',
    'toleranceMs',
    options.toleranceMs ?? DEFAULT_SNS_TOLERANCE_MS,
    1,
  );
  const doFetch: MailFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const verify = {
    topicArns,
    toleranceMs,
    clock: options.clock,
    fetchCertificate: options.fetchCertificate ?? defaultCertificateFetch(doFetch),
    certificates: new Map<string, Uint8Array<ArrayBuffer>>(),
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
    if (!isPinnedSnsUrl(confirmUrl, region, '')) throw deliveryEventInvalid('ses', 'envelope');
    if (options.confirmSubscriptions !== true) {
      return { type: 'subscription', topicArn: message.TopicArn, confirmUrl, confirmed: false };
    }
    let response: Response;
    try {
      response = await doFetch(confirmUrl, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      throw deliveryProviderUnreachable('subscription', renderThrowable(error));
    }
    await response.body?.cancel();
    if (!response.ok) throw deliveryProviderUnreachable('subscription', `HTTP ${response.status}`);
    return { type: 'subscription', topicArn: message.TopicArn, confirmUrl, confirmed: true };
  }
}

function deliveryEventConfig(): ConfigInvalidError {
  return new ConfigInvalidError({
    cause:
      'createSesEventReceiver needs at least one topic ARN, and every one must be an SNS topic ARN',
    fix: "createSesEventReceiver({ topicArns: ['arn:aws:sns:us-east-1:123456789012:ses-events'] }) — the topics this route is subscribed to (aws sns list-topics)",
  });
}
