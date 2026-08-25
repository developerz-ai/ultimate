// Single responsibility: the webhook wire format — the canonical string, the mac over it, the
// three headers a delivery carries, and the parse of the one header a receiver reads back.
//
// It lives HERE for the reason `timing-safe-equal.ts` does, in that file's own words: two packages
// need the identical guarantee and cannot share it any other way. `@ultimat3/jobs` (tier 3) signs
// a delivery and its boundary forbids `@ultimat3/http`; `@ultimat3/http` (tier 2) verifies one and
// may not reach tier 3. Neither is the other's dependency, so the one copy lives at the tier both
// can reach. Before this module the spelling was stated twice and held together by a hex literal
// asserted in two test files — which works and is not a single source of truth.
//
// FORMAT and never POLICY. What counts as fresh, how large a body may be, and which status a
// refusal answers with are the receiver's questions and stay in `@ultimat3/http`.

/** The format's version: the first field of the canonical string, and the signature's key. */
export const WEBHOOK_SIGNATURE_VERSION = 'v1';

export const WEBHOOK_ID_HEADER = 'x-ultimate-webhook-id';
export const WEBHOOK_TOPIC_HEADER = 'x-ultimate-webhook-topic';
export const WEBHOOK_SIGNATURE_HEADER = 'x-ultimate-webhook-signature';

/** Bounds the canonical string, the header echo and any error text built from either. */
export const WEBHOOK_FIELD_MAX = 200;

/** Fields a spreadsheet-free reader still must not let move a separator. See below. */
const SEPARATOR = 0x3a;
const DELETE = 0x7f;

/** `t=<digits>,v1=<hex>`, in either order, with nothing else accepted. */
const SIGNATURE_FIELD = /^([a-z0-9]+)=([A-Za-z0-9_-]+)$/;
/** Digits only and bounded — see `parseWebhookSignatureHeader`. */
const TIMESTAMP = /^\d{1,15}$/;

/**
 * A field may not move the `:` separators. Without this rule an event id of `evt:01HZ` with topic
 * `orders.paid` and an id of `evt` with topic `01HZ:orders.paid` build the SAME canonical string —
 * one mac authenticating two differently-labelled deliveries, which is the sender's own signature
 * under a label it never wrote. A control character is refused for a second reason: these fields
 * are sent as HTTP header values, and a CR or LF in one is a header nobody wrote.
 */
export function isCanonicalWebhookField(value: string): boolean {
  if (value.length === 0 || value.length > WEBHOOK_FIELD_MAX) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === SEPARATOR || code < 0x20 || code === DELETE) return false;
  }
  return true;
}

export interface WebhookSigningInput {
  /** The shared secret for this endpoint. Never logged, never rendered into an error. */
  readonly secret: string;
  /**
   * When this REQUEST is signed — not when the event happened. A delivery retried three days later
   * signs again at the moment it is sent, so a receiver's freshness window measures the request in
   * front of it rather than the age of the fact behind it.
   */
  readonly timestampSeconds: number;
  readonly eventId: string;
  readonly topic: string;
  /** The exact text the delivery sends. Serialised by the app, signed here byte for byte. */
  readonly body: string;
}

/** The bytes the mac is taken over. One function, so the format has one spelling anywhere. */
export function webhookSigningString(input: WebhookSigningInput): string {
  return `${WEBHOOK_SIGNATURE_VERSION}:${input.timestampSeconds}:${input.eventId}:${input.topic}:${input.body}`;
}

export interface WebhookMacInput {
  readonly secret: string;
  /**
   * The timestamp exactly as it is spelled on the wire. A STRING and not a number, because a mac
   * is over bytes: re-rendering it would make `t=01700000000` and `t=1700000000` one signature
   * over two different headers.
   */
  readonly timestampText: string;
  readonly eventId: string;
  readonly topic: string;
  /**
   * Text on the sending side, raw BYTES on the receiving one. Identical either way — an HMAC is
   * over a byte stream and `update(string)` encodes UTF-8 — and the bytes form never round-trips a
   * body that is not valid UTF-8 through a decoder before the mac is taken over it.
   */
  readonly body: string | Uint8Array;
}

/** The hex hmac-sha256 over the canonical string. The one place either side computes one. */
export function webhookMac(input: WebhookMacInput): string {
  const hasher = new Bun.CryptoHasher('sha256', input.secret);
  hasher.update(
    `${WEBHOOK_SIGNATURE_VERSION}:${input.timestampText}:${input.eventId}:${input.topic}:`,
  );
  hasher.update(input.body);
  return hasher.digest('hex');
}

/**
 * The `x-ultimate-webhook-signature` value: `t=<seconds>,v1=<hex hmac-sha256>`.
 *
 * The timestamp travels in the header AND inside the mac. Both are needed: the header is what the
 * receiver measures its window against, and the copy under the mac is what stops that header being
 * edited on a captured request.
 */
export function webhookSignature(input: WebhookSigningInput): string {
  const timestampText = String(input.timestampSeconds);
  const mac = webhookMac({ ...input, timestampText });
  return `t=${timestampText},${WEBHOOK_SIGNATURE_VERSION}=${mac}`;
}

/** Every header a delivery carries beyond `content-type`. One composition over the two above. */
export function webhookHeaders(input: WebhookSigningInput): Readonly<Record<string, string>> {
  return {
    [WEBHOOK_ID_HEADER]: input.eventId,
    [WEBHOOK_TOPIC_HEADER]: input.topic,
    [WEBHOOK_SIGNATURE_HEADER]: webhookSignature(input),
  };
}

export interface WebhookSignatureFields {
  /** As spelled on the wire — what `webhookMac` must be given. */
  readonly timestampText: string;
  readonly timestampSeconds: number;
  readonly mac: string;
}

/**
 * The header, or `undefined` for anything this format does not define. It parses and never judges:
 * whether the timestamp is FRESH is the receiver's question and lives one tier up.
 */
export function parseWebhookSignatureHeader(
  header: string | null,
): WebhookSignatureFields | undefined {
  if (header === null) return undefined;
  let timestamp: string | undefined;
  let mac: string | undefined;
  for (const part of header.split(',')) {
    const match = SIGNATURE_FIELD.exec(part.trim());
    if (match === null) return undefined;
    const [, key, value] = match;
    if (key === 't') timestamp = value;
    else if (key === WEBHOOK_SIGNATURE_VERSION) mac = value;
  }
  if (timestamp === undefined || mac === undefined) return undefined;
  // Digits only, and bounded. Without it `Number('nope')` is `NaN`, `NaN > toleranceMs` is FALSE,
  // and a receiver's freshness window silently accepts every delivery — the one guard here whose
  // failure mode is "the check does not run" rather than "the check refuses".
  if (!TIMESTAMP.test(timestamp)) return undefined;
  return { timestampText: timestamp, timestampSeconds: Number(timestamp), mac };
}
