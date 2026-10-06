// Single responsibility: prove an Amazon SNS HTTP(S) message was signed by SNS for a topic this
// app owns. The AWS-documented procedure: the topic first (any AWS account can make SNS sign for
// ITS topic), the certificate URL pinned to `https://sns.<topic region>.amazonaws.com`, the
// canonical string per message type, RSA-SHA1 (v1) or RSA-SHA256 (v2) through Web Crypto.

import { type Clock, isUltimateError, renderThrowable, systemClock } from '@ultimat3/core';
import { t, validate } from '@ultimat3/schema';
import { deliveryInstant } from './delivery-event';
import {
  deliveryEventInvalid,
  deliveryEventUnverified,
  deliveryProviderUnreachable,
} from './delivery-event-errors';
import { certificateSpki, pemCertificateDer } from './x509-spki';

/** The envelope fields the signature covers, plus the three that say how it was signed. */
export interface SnsMessage {
  readonly Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';
  readonly MessageId: string;
  readonly TopicArn: string;
  readonly Message: string;
  readonly Timestamp: string;
  readonly Subject?: string | undefined;
  readonly SubscribeURL?: string | undefined;
  readonly Token?: string | undefined;
  readonly SignatureVersion: string;
  readonly Signature: string;
  readonly SigningCertURL: string;
}

/** PEM text for a certificate URL. Injected in tests; production GETs it over pinned https. */
export type SnsCertificateFetch = (url: string) => Promise<string>;

const envelope = t.object({
  Type: t.enum(['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation']),
  MessageId: t.string,
  TopicArn: t.string,
  Message: t.string,
  Timestamp: t.string,
  Subject: t.string.optional(),
  SubscribeURL: t.string.optional(),
  Token: t.string.optional(),
  SignatureVersion: t.string.optional(),
  Signature: t.string.optional(),
  SigningCertURL: t.string.optional(),
});

/** `arn:aws:sns:<region>:<account>:<name>` — the region is what the certificate host is pinned to. */
const TOPIC_ARN =
  /^arn:aws(?:-us-gov)?:sns:([a-z]{2}(?:-[a-z]+)+-\d{1,2}):\d{12}:[A-Za-z0-9_-]{1,256}(?:\.fifo)?$/;

/** AWS's documented key order, per message type. `Subject` is signed only when present. */
const CONFIRMATION_KEYS: readonly (keyof SnsMessage)[] = [
  'Message',
  'MessageId',
  'SubscribeURL',
  'Timestamp',
  'Token',
  'TopicArn',
  'Type',
];
/** A Map: `Type` came off the wire, and an object table answers `constructor` from its prototype. */
const SIGNED_KEYS: ReadonlyMap<SnsMessage['Type'], readonly (keyof SnsMessage)[]> = new Map([
  ['Notification', ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']],
  ['SubscriptionConfirmation', CONFIRMATION_KEYS],
  ['UnsubscribeConfirmation', CONFIRMATION_KEYS],
]);

/** `SignatureVersion` is a wire value: `"constructor"` must find nothing here. */
const HASH_OF: ReadonlyMap<string, 'SHA-1' | 'SHA-256'> = new Map([
  ['1', 'SHA-1'],
  ['2', 'SHA-256'],
]);

/** `"Key\nValue\n"` for each signed key present, in the documented order. */
export function snsCanonicalString(message: SnsMessage): string {
  let canonical = '';
  for (const key of SIGNED_KEYS.get(message.Type) ?? []) {
    const value = message[key];
    if (value !== undefined) canonical += `${key}\n${value}\n`;
  }
  return canonical;
}

/** The region of an ARN this module accepts, or `undefined` for one it does not. */
export function snsTopicRegion(topicArn: string): string | undefined {
  return TOPIC_ARN.exec(topicArn)?.[1];
}

/** The only path SNS serves a signing certificate from. */
const CERT_PATH = /^\/SimpleNotificationService-[0-9a-f]{1,64}\.pem$/;

/**
 * A signing-certificate URL in its ONE spelling: `https://sns.<region>.amazonaws.com/SimpleNotificationService-<hex>.pem`,
 * compared as a string against what the parse normalises it to. Every alias of one URL — a
 * fragment, `:443`, a bare `?`, `\` for `/`, an upper-case or full-width host — is refused rather
 * than normalised, because each alias would be a distinct cache key and so a certificate fetch an
 * unauthenticated sender could force before any signature is checked.
 */
export function isPinnedCertificateUrl(raw: string, region: string): boolean {
  const url = URL.parse(raw);
  if (url === null || !CERT_PATH.test(url.pathname)) return false;
  return raw === `https://sns.${region}.amazonaws.com${url.pathname}`;
}

/** A SubscribeURL: the pinned origin, path `/`, a query, no fragment, no userinfo, no port. */
export function isPinnedSubscribeUrl(raw: string, region: string): boolean {
  const url = URL.parse(raw);
  if (url === null || url.hash !== '' || url.pathname !== '/' || url.search === '') return false;
  return raw.startsWith(`https://sns.${region}.amazonaws.com/?`);
}

function base64Bytes(text: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

export interface SnsVerifyOptions {
  /** Every topic this app subscribed this route to. Anything else is refused before any fetch. */
  readonly topicArns: ReadonlySet<string>;
  readonly fetchCertificate: SnsCertificateFetch;
  readonly toleranceMs: number;
  readonly clock?: Clock | undefined;
  /**
   * SPKI per certificate URL, as the PROMISE of it: concurrent messages naming one URL share one
   * download. The receiver owns it; SNS rotates by publishing a new URL.
   */
  readonly certificates: Map<string, Promise<Uint8Array<ArrayBuffer>>>;
}

/** Parse, pin, fetch, verify, then check the clock — and answer the message that was signed. */
export async function verifySnsMessage(
  parsed: unknown,
  options: SnsVerifyOptions,
): Promise<SnsMessage> {
  const result = validate(envelope, parsed);
  if (result.issues !== undefined) throw deliveryEventInvalid('ses', 'envelope');
  const fields = result.value;
  const { Signature: signature, SigningCertURL: certUrl, SignatureVersion: version } = fields;
  if (signature === undefined || certUrl === undefined || version === undefined) {
    throw deliveryEventUnverified('ses', 'unsigned');
  }
  if (!options.topicArns.has(fields.TopicArn)) throw deliveryEventUnverified('ses', 'topic');
  const region = snsTopicRegion(fields.TopicArn);
  if (region === undefined || !isPinnedCertificateUrl(certUrl, region)) {
    throw deliveryEventUnverified('ses', 'certificate-url');
  }
  const hash = HASH_OF.get(version);
  if (hash === undefined) throw deliveryEventUnverified('ses', 'signature-version');
  const message: SnsMessage = {
    ...fields,
    SignatureVersion: version,
    Signature: signature,
    SigningCertURL: certUrl,
  };

  const signatureBytes = base64Bytes(signature);
  const spki = await certificateFor(certUrl, options);
  if (signatureBytes === undefined || !(await rsaVerifies(spki, hash, signatureBytes, message))) {
    throw deliveryEventUnverified('ses', 'signature');
  }
  // After the signature, like `@ultimat3/http`'s receiver: "stale" then always means authentic.
  const sentAt = deliveryInstant('ses', fields.Timestamp).getTime();
  const now = (options.clock ?? systemClock).now().getTime();
  if (Math.abs(now - sentAt) > options.toleranceMs) {
    throw deliveryEventUnverified('ses', 'stale');
  }
  return message;
}

async function rsaVerifies(
  spki: Uint8Array<ArrayBuffer>,
  hash: 'SHA-1' | 'SHA-256',
  signature: Uint8Array<ArrayBuffer>,
  message: SnsMessage,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'spki',
      spki,
      { name: 'RSASSA-PKCS1-v1_5', hash },
      false,
      ['verify'],
    );
    const canonical = new TextEncoder().encode(snsCanonicalString(message));
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, canonical);
  } catch {
    // A key Web Crypto will not import (not RSA) verifies nothing.
    return false;
  }
}

/** Bounded: a flood of distinct pinned URLs cannot grow it past this many keys. */
const MAX_CACHED_CERTIFICATES = 8;

function certificateFor(url: string, options: SnsVerifyOptions): Promise<Uint8Array<ArrayBuffer>> {
  const cached = options.certificates.get(url);
  if (cached !== undefined) return cached;
  if (options.certificates.size >= MAX_CACHED_CERTIFICATES) options.certificates.clear();
  const pending = downloadCertificate(url, options);
  options.certificates.set(url, pending);
  // A failed download is forgotten, so the next message retries it instead of inheriting it.
  pending.catch(() => {
    if (options.certificates.get(url) === pending) options.certificates.delete(url);
  });
  return pending;
}

async function downloadCertificate(
  url: string,
  options: SnsVerifyOptions,
): Promise<Uint8Array<ArrayBuffer>> {
  let pem: string;
  try {
    pem = await options.fetchCertificate(url);
  } catch (error) {
    // The default download already names its failure; an injected one may throw anything.
    if (isUltimateError(error)) throw error;
    throw deliveryProviderUnreachable('certificate', renderThrowable(error));
  }
  const der = pemCertificateDer(pem);
  const spki = der === undefined ? undefined : certificateSpki(der);
  if (spki === undefined) {
    throw deliveryProviderUnreachable('certificate', 'the answer was not a PEM X.509 certificate');
  }
  return new Uint8Array(spki);
}
