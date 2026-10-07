// Single responsibility: the refusals a delivery-notification receiver answers with. Three codes,
// one per audience: an unauthenticated sender (401), a signed payload this package cannot read
// (400), and a provider endpoint the check itself needed that did not answer (503, so SNS retries).
// No cause or fix here ever carries a signature, a secret, a body or a sender-chosen value.

import { MailError } from './errors';

export type DeliveryProvider = 'ses' | 'resend';

/**
 * Why a notification was refused as unauthenticated. One code and a `meta.reason`, like
 * `X_MAIL_HEADER_INVALID`: the receiver's answer is the same 401 for each, and the operator reads
 * the reason to learn whether to fix a secret, a topic list or a clock.
 */
export type DeliveryRefusal =
  | 'unsigned'
  | 'signature'
  | 'stale'
  | 'topic'
  | 'certificate-url'
  | 'signature-version';

const CAUSES: Readonly<Record<DeliveryRefusal, string>> = {
  unsigned: 'carries no signature, so nothing proves who sent it',
  signature: 'carries a signature that does not verify over the bytes that arrived',
  stale:
    'is signed correctly and its timestamp is outside the tolerance window — a replay or a skewed clock',
  topic:
    'names an SNS topic this receiver was not configured with — any AWS account can sign for its own topic',
  'certificate-url':
    'names a signing certificate that is not https://sns.<region>.amazonaws.com for its topic’s region',
  'signature-version': 'declares a SignatureVersion other than 1 or 2',
};

/** The three refusals a Svix-signed sender can earn; the other three are SNS envelope rules. */
export type ResendRefusal = 'unsigned' | 'signature' | 'stale';

const RESEND_FIXES: ReadonlyMap<DeliveryRefusal, string> = new Map<DeliveryRefusal, string>([
  [
    'unsigned',
    "curl -sS https://api.resend.com/webhooks -H 'Authorization: Bearer <RESEND_API_KEY>' — point the Resend webhook at this route; Resend signs every delivery with svix-* headers",
  ],
  [
    'signature',
    "resendEventReceiver({ secret: env.RESEND_WEBHOOK_SECRET }) — with this endpoint's whsec_ signing secret from https://resend.com/webhooks",
  ],
  [
    'stale',
    'resendEventReceiver({ secret, toleranceMs: 600_000 }) — or sync this host clock: timedatectl set-ntp true',
  ],
]);

const SES_FIXES: ReadonlyMap<DeliveryRefusal, string> = new Map<DeliveryRefusal, string>([
  [
    'unsigned',
    'aws sns subscribe --protocol https --topic-arn <your topic arn> --notification-endpoint <this url> — SNS signs every message it sends',
  ],
  [
    'signature',
    'aws sns list-subscriptions-by-topic --topic-arn <your topic arn> — and let nothing between SNS and this route re-serialise the JSON body',
  ],
  [
    'stale',
    'sesEventReceiver({ topicArns, toleranceMs: 7_200_000 }) — or sync this host clock: timedatectl set-ntp true',
  ],
  [
    'topic',
    'aws sns list-topics — then, only if the topic is yours, sesEventReceiver({ topicArns: [<your topic arn>] })',
  ],
  [
    'certificate-url',
    'aws sns list-topics — nothing to change if you did not send it: SNS signs only from https://sns.<region>.amazonaws.com',
  ],
  [
    'signature-version',
    'aws sns set-topic-attributes --topic-arn <your topic arn> --attribute-name SignatureVersion --attribute-value 2',
  ],
]);

export function deliveryEventUnverified(provider: 'resend', reason: ResendRefusal): MailError;
export function deliveryEventUnverified(provider: 'ses', reason: DeliveryRefusal): MailError;
export function deliveryEventUnverified(
  provider: DeliveryProvider,
  reason: DeliveryRefusal,
): MailError {
  // The overloads keep an SNS-only reason off a Resend refusal, so the fallback is never reached.
  // Maps, never object lookups: `reason` is a closed union today, and a table that is not an
  // object cannot answer `Object.prototype` for a key nobody declared.
  const table = provider === 'resend' ? RESEND_FIXES : SES_FIXES;
  const fix = table.get(reason) ?? 'aws sns list-topics — no fix is declared for this reason';
  return new MailError({
    code: 'X_MAIL_EVENT_UNVERIFIED',
    cause: `a ${provider} delivery notification ${CAUSES[reason]}`,
    fix,
    meta: { provider, reason },
  });
}

/** What could not be read. A closed vocabulary, so a cause never echoes the sender's bytes. */
export type DeliveryShapeProblem =
  | 'too-large'
  | 'not-utf8'
  | 'not-json'
  | 'envelope'
  | 'notification'
  | 'timestamp';

const SHAPE_CAUSES: Readonly<Record<DeliveryShapeProblem, string>> = {
  'too-large': 'is larger than the receiver’s maxBytes',
  'not-utf8': 'is not UTF-8 text',
  'not-json': 'is not JSON',
  envelope: 'is missing a field its envelope requires',
  notification: 'is missing a field its event type requires',
  timestamp: 'carries a timestamp that is not an ISO-8601 instant',
};

export const deliveryEventInvalid = (
  provider: DeliveryProvider,
  problem: DeliveryShapeProblem,
): MailError =>
  new MailError({
    code: 'X_MAIL_EVENT_INVALID',
    cause: `a ${provider} delivery notification ${SHAPE_CAUSES[problem]}`,
    fix:
      problem === 'too-large'
        ? provider === 'ses'
          ? 'sesEventReceiver({ topicArns, maxBytes: 2_097_152 }) — only if SNS really sends more'
          : 'resendEventReceiver({ secret, maxBytes: 2_097_152 }) — only if Resend really sends more'
        : provider === 'ses'
          ? 'aws sns list-subscriptions-by-topic --topic-arn <your topic arn> — only SNS should be posting to this route'
          : "curl -sS https://api.resend.com/webhooks -H 'Authorization: Bearer <RESEND_API_KEY>' — only Resend should be posting to this route",
    meta: { provider, problem },
  });

/** The SNS signing certificate (or a subscription confirm) did not answer — transient, so 503. */
export const deliveryProviderUnreachable = (
  what: 'certificate' | 'subscription',
  detail: string,
): MailError =>
  new MailError({
    code: 'X_MAIL_EVENT_PROVIDER_UNREACHABLE',
    cause: `the SNS ${what === 'certificate' ? 'signing certificate' : 'subscription confirmation'} request failed: ${detail}`,
    fix:
      what === 'certificate'
        ? 'curl -sS -m 5 -o /dev/null https://sns.us-east-1.amazonaws.com/ — checks egress; SNS redelivers a message this route answered 5xx'
        : 'aws sns confirm-subscription --topic-arn <your topic arn> --token <the Token from the confirmation>',
    meta: { provider: 'ses', what },
  });
