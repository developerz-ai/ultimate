// Single responsibility: the recorded delivery notifications the receiver tests replay, and the
// test signer behind them. The SNS envelopes and SES/Resend payloads are the shapes AWS and Resend
// document, field for field; the SNS key and its self-signed X.509 certificate are generated per
// run with Web Crypto (no private key is committed), and the certificate DER is built here by hand.

import { canonicalJson } from '@ultimat3/core';
import { type SnsMessage, snsCanonicalString } from './sns-signature';

export const TOPIC_ARN = 'arn:aws:sns:us-west-2:123456789012:ses-events';
export const CERT_URL =
  'https://sns.us-west-2.amazonaws.com/SimpleNotificationService-f3ecfb7224c7233fe7bb5f59f96de52f.pem';
export const UNSUBSCRIBE_URL =
  'https://sns.us-west-2.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=arn:aws:sns:us-west-2:123456789012:ses-events:c9135db0-26c4-47ec-8998-413945fb5a96';

/** SES identity notification, `Bounce`, as AWS documents it (addresses moved to `.test`). */
export const SES_BOUNCE = {
  notificationType: 'Bounce',
  bounce: {
    bounceType: 'Permanent',
    reportingMTA: 'dns; email.example.test',
    bouncedRecipients: [
      {
        emailAddress: 'jane@example.test',
        status: '5.1.1',
        action: 'failed',
        diagnosticCode: 'smtp; 550 5.1.1 <jane@example.test>... User',
      },
      { emailAddress: 'richard@example.test', status: '5.1.1', action: 'failed' },
    ],
    bounceSubType: 'General',
    timestamp: '2026-10-06T11:59:38.237Z',
    feedbackId: '00000138111222aa-33322211-cccc-cccc-cccc-ddddaaaa068a-000000',
    remoteMtaIp: '127.0.2.0',
  },
  mail: {
    timestamp: '2026-10-06T11:59:37.000Z',
    source: 'no-reply@postly.test',
    sourceArn: 'arn:aws:ses:us-west-2:123456789012:identity/postly.test',
    sendingAccountId: '123456789012',
    messageId: '0102018f6c2d4e1a-8b1c2d3e-4f5a-6b7c-8d9e-0f1a2b3c4d5e-000000',
    destination: ['jane@example.test', 'richard@example.test'],
  },
} as const;

/** A configuration-set `eventType` spelling, `Complaint`. */
export const SES_COMPLAINT = {
  eventType: 'Complaint',
  complaint: {
    complainedRecipients: [{ emailAddress: 'ada@example.test' }],
    timestamp: '2026-10-06T11:58:00.000Z',
    feedbackId: '0000013786031775-163e3910-53eb-4c8e-a04a-f29debf88a84-000000',
    complaintFeedbackType: 'abuse',
  },
  mail: { messageId: '0102018f6c2d4e1a-complaint-000000', destination: ['ada@example.test'] },
} as const;

export const SES_DELIVERY = {
  notificationType: 'Delivery',
  delivery: {
    timestamp: '2026-10-06T11:59:40.000Z',
    processingTimeMillis: 546,
    recipients: ['grace@example.test'],
    smtpResponse: '250 ok:  Message 64111812 accepted',
    reportingMTA: 'a8-70.smtp-out.amazonses.com',
  },
  mail: { messageId: '0102018f6c2d4e1a-delivery-000000', destination: ['grace@example.test'] },
} as const;

/** A Resend `email.bounced` webhook body, as Resend documents it. */
export const RESEND_BOUNCED = {
  type: 'email.bounced',
  created_at: '2026-10-06T11:59:50.000Z',
  data: {
    broadcast_id: null,
    created_at: '2026-10-06T11:59:00.000Z',
    email_id: '56761188-7520-42d8-8898-ff6fc54ce618',
    from: 'Postly <no-reply@postly.test>',
    to: ['jane@example.test'],
    subject: 'Welcome to Postly',
    bounce: {
      message: "The recipient's email address is on the suppression list.",
      subType: 'Suppressed',
      type: 'Permanent',
    },
  },
} as const;

// ── DER, just enough for one self-signed certificate ──────────────────────────────────────────────

const ascii = (text: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new TextEncoder().encode(text));

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

function tlv(tag: number, ...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const body = concat(parts);
  const n = body.byteLength;
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return concat([Uint8Array.of(tag, ...length), body]);
}

const SHA256_WITH_RSA = Uint8Array.of(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b);
const COMMON_NAME = Uint8Array.of(0x55, 0x04, 0x03);
const algorithm = tlv(0x30, tlv(0x06, SHA256_WITH_RSA), tlv(0x05));
const name = tlv(0x31, tlv(0x30, tlv(0x06, COMMON_NAME), tlv(0x0c, ascii('sns.amazonaws.com'))));

/** `version` false builds an X.509 v1 certificate, which has no `[0]` field. */
async function selfSigned(keys: CryptoKeyPair, version: boolean): Promise<Uint8Array> {
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  const tbs = tlv(
    0x30,
    ...(version ? [tlv(0xa0, tlv(0x02, Uint8Array.of(2)))] : []),
    tlv(0x02, Uint8Array.of(0x01, 0x42)),
    algorithm,
    tlv(0x30, name),
    tlv(0x30, tlv(0x17, ascii('260101000000Z')), tlv(0x17, ascii('360101000000Z'))),
    tlv(0x30, name),
    spki,
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, tbs);
  return tlv(0x30, tbs, algorithm, tlv(0x03, Uint8Array.of(0), new Uint8Array(signature)));
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export const pem = (der: Uint8Array): string =>
  `-----BEGIN CERTIFICATE-----\n${(toBase64(der).match(/.{1,64}/g) ?? []).join('\n')}\n-----END CERTIFICATE-----\n`;

export interface SnsSigner {
  readonly certificatePem: string;
  /** The same key in an X.509 v1 certificate. */
  readonly v1CertificatePem: string;
  /** The raw signature bytes for an envelope, so a test can flip one and re-encode. */
  signatureOf(message: Omit<SnsMessage, 'Signature'>): Promise<Uint8Array>;
  /** A complete signed envelope, as SNS POSTs it. */
  sign(
    fields: Omit<SnsMessage, 'Signature' | 'SignatureVersion' | 'SigningCertURL'>,
    version?: '1' | '2',
  ): Promise<SnsMessage>;
}

const RSA = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: Uint8Array.of(1, 0, 1),
};

export async function snsSigner(): Promise<SnsSigner> {
  const keys = await crypto.subtle.generateKey({ ...RSA, hash: 'SHA-256' }, true, [
    'sign',
    'verify',
  ]);
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keys.privateKey);
  const sha1 = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: RSA.name, hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signatureOf = async (message: Omit<SnsMessage, 'Signature'>): Promise<Uint8Array> => {
    const key = message.SignatureVersion === '1' ? sha1 : keys.privateKey;
    const canonical = new TextEncoder().encode(snsCanonicalString({ ...message, Signature: '' }));
    return new Uint8Array(await crypto.subtle.sign(RSA.name, key, canonical));
  };
  return {
    certificatePem: pem(await selfSigned(keys, true)),
    v1CertificatePem: pem(await selfSigned(keys, false)),
    signatureOf,
    async sign(fields, version = '2') {
      const unsigned = { ...fields, SignatureVersion: version, SigningCertURL: CERT_URL };
      return { ...unsigned, Signature: toBase64(await signatureOf(unsigned)) };
    },
  };
}

/** A Notification envelope around an SES payload, signed. */
export function sesNotification(
  signer: SnsSigner,
  payload: unknown,
  overrides: Partial<SnsMessage> = {},
): Promise<SnsMessage> {
  return signer.sign({
    Type: 'Notification',
    MessageId: '22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324',
    TopicArn: TOPIC_ARN,
    Message: canonicalJson(payload),
    Timestamp: '2026-10-06T12:00:00.000Z',
    ...overrides,
  });
}

/** What SNS POSTs: the envelope as JSON, `UnsubscribeURL` included (it is not signed). */
export const snsBody = (message: SnsMessage): string =>
  JSON.stringify({ ...message, UnsubscribeURL: UNSUBSCRIBE_URL });

export const snsRequest = (body: string): Request =>
  new Request('https://app.test/api/mail/ses', {
    method: 'POST',
    headers: {
      'content-type': 'text/plain; charset=UTF-8',
      'x-amz-sns-message-type': 'Notification',
    },
    body,
  });

// ── Resend / Svix ─────────────────────────────────────────────────────────────────────────────────

/** `whsec_` + base64 of 24 fixed test bytes. Not a secret: it signs fixtures only. */
export const RESEND_SECRET = `whsec_${toBase64(ascii('resend-fixture-secret-24'))}`;

export async function svixSignature(id: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    ascii('resend-fixture-secret-24'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, ascii(`${id}.${timestamp}.${body}`));
  return `v1,${toBase64(new Uint8Array(mac))}`;
}

export const resendRequest = (body: string, headers: Readonly<Record<string, string>>): Request =>
  new Request('https://app.test/api/mail/resend', { method: 'POST', headers, body });
