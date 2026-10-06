// Single responsibility: AWS Signature Version 4 over one HTTP request — the framework's ONE SigV4
// implementation, shared by `@ultimat3/storage`'s s3 disk and `@ultimat3/mail`'s SES driver, which
// sit at tiers that cannot import each other. Web Crypto only (HMAC-SHA256, SHA-256), no SDK, and
// the instant is an injected `Clock`, so a test signs against AWS's own known answers.

import { assert } from './assert';
import { type Clock, systemClock } from './clock';
import { describeValue } from './error-render';

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** STS / instance-role credentials: sent and signed as `x-amz-security-token`. */
  readonly sessionToken?: string | undefined;
}

/** The literal S3 accepts in place of a body hash — a stream, or bytes too large to hash twice. */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/**
 * What the signature says about the body. Absent is the EMPTY body. `{ body }` is hashed here;
 * `{ sha256Hex }` is a hash the caller already took (a stream it hashed while buffering);
 * `UNSIGNED_PAYLOAD` signs no body at all, which S3 accepts over TLS.
 */
export type AwsPayload =
  | { readonly body: Uint8Array | string }
  | { readonly sha256Hex: string }
  | typeof UNSIGNED_PAYLOAD;

export interface SignAwsRequestInput {
  readonly method: string;
  /** Absolute. The path and query are re-encoded strictly; the URL returned is the one signed. */
  readonly url: string | URL;
  /** Every header here is signed. `host` defaults to the URL's; `authorization`/`x-amz-date` are the signer's. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly payload?: AwsPayload | undefined;
  readonly credentials: AwsCredentials;
  /** `us-east-1`, or `auto` for R2. */
  readonly region: string;
  /** `s3`, `ses`, `email`, … — the scope's service segment. */
  readonly service: string;
  /** Default `systemClock`. The signature is only valid within ~15 minutes of this instant. */
  readonly clock?: Clock | undefined;
  /**
   * Encode each path segment twice. Default `service !== 's3'`: every AWS service but S3 signs the
   * already-encoded path again; S3 signs the key encoded once.
   */
  readonly doubleEncodePath?: boolean | undefined;
  /** Send and sign `x-amz-content-sha256`. Default `service === 's3'`, which requires it. */
  readonly contentSha256Header?: boolean | undefined;
}

export interface SignedAwsRequest {
  readonly method: string;
  /** The URL to send: the input's, with the path and query in the encoding that was signed. */
  readonly url: string;
  /** Every header to send — lower-case names, `authorization` included. */
  readonly headers: Readonly<Record<string, string>>;
  /** The two intermediate strings, exposed so a provider's `SignatureDoesNotMatch` can be diffed. */
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signature: string;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SCOPE_SEGMENT = /^[a-z0-9-]{1,64}$/;
const METHOD = /^[A-Z]{1,16}$/;
/** Headers the signer writes itself; a caller's copy would sign a value the request does not carry. */
const SIGNER_OWNED: ReadonlySet<string> = new Set([
  'authorization',
  'x-amz-date',
  'x-amz-security-token',
  'x-amz-content-sha256',
]);

const encoder = new TextEncoder();

const toHex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');

/** Web Crypto takes an ArrayBuffer-backed view; only a view over shared memory is copied. */
const ownedBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> =>
  bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : ownedBytes(data);
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: string): Promise<Uint8Array<ArrayBuffer>> {
  const imported = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, encoder.encode(data)));
}

/** RFC 3986 unreserved bytes stay; everything else is `%XX`, upper-case — SigV4's `UriEncode`. */
function uriEncode(value: string): string {
  let encoded: string;
  try {
    encoded = encodeURIComponent(value);
  } catch {
    // A lone surrogate: there are no UTF-8 bytes to sign.
    assert(
      false,
      'an AWS request URL holds a lone UTF-16 surrogate, which has no UTF-8 encoding',
      'build the key from well-formed text: value.toWellFormed()',
    );
  }
  return encoded.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function uriDecode(value: string, where: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    assert(
      false,
      `an AWS request ${where} holds a malformed percent-escape (${describeValue(value)}), so no canonical form exists to sign`,
      'encode each segment with encodeURIComponent() before building the URL — a literal % is %25',
    );
  }
}

function canonicalPath(pathname: string, doubleEncode: boolean): string {
  if (pathname === '') return '/';
  return pathname
    .split('/')
    .map((segment) => {
      const once = uriEncode(uriDecode(segment, 'path'));
      return doubleEncode ? uriEncode(once) : once;
    })
    .join('/');
}

/** Pairs decoded then strictly re-encoded, sorted by key then value; a bare `key` is `key=`. */
function canonicalQuery(search: string): string {
  const pairs: [string, string][] = [];
  for (const part of search.replace(/^\?/, '').split('&')) {
    if (part === '') continue;
    const at = part.indexOf('=');
    const key = at === -1 ? part : part.slice(0, at);
    const value = at === -1 ? '' : part.slice(at + 1);
    pairs.push([uriEncode(uriDecode(key, 'query')), uriEncode(uriDecode(value, 'query'))]);
  }
  pairs.sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : 1) : ak < bk ? -1 : 1));
  return pairs.map(([key, value]) => `${key}=${value}`).join('&');
}

/** Lower-case names, trimmed values with inner whitespace runs collapsed, duplicates comma-joined. */
function canonicalHeaders(headers: Readonly<Record<string, string>>): Map<string, string> {
  const merged = new Map<string, string>();
  for (const [name, raw] of Object.entries(headers)) {
    const key = name.trim().toLowerCase();
    const value = raw.trim().replace(/\s+/g, ' ');
    const prior = merged.get(key);
    merged.set(key, prior === undefined ? value : `${prior},${value}`);
  }
  return new Map([...merged].sort(([a], [b]) => (a < b ? -1 : 1)));
}

function parseUrl(url: string | URL): URL {
  if (url instanceof URL) return url;
  assert(
    URL.canParse(url),
    `signAwsRequest was handed a url that is not absolute (${describeValue(url)})`,
    "pass the whole endpoint URL: signAwsRequest({ url: 'https://<host>/<path>', … })",
  );
  return new URL(url);
}

function assertInput(input: SignAwsRequestInput): void {
  const { accessKeyId, secretAccessKey } = input.credentials;
  assert(
    accessKeyId !== '' && secretAccessKey !== '',
    'signAwsRequest was handed an empty access key id or secret, so nothing can be signed',
    'set the access key id and secret (S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY, or the driver’s own env names), then re-run',
  );
  for (const [name, value] of [
    ['region', input.region],
    ['service', input.service],
  ] as const) {
    assert(
      SCOPE_SEGMENT.test(value),
      `signAwsRequest was handed a ${name} that cannot be a credential-scope segment (${describeValue(value)})`,
      `pass a lower-case ${name} of letters, digits and hyphens — region: 'us-east-1', service: 's3'`,
    );
  }
  assert(
    METHOD.test(input.method),
    `signAwsRequest was handed an HTTP method that is not upper-case letters (${describeValue(input.method)})`,
    "pass the method as sent on the wire: method: 'PUT'",
  );
}

async function payloadHash(payload: AwsPayload | undefined): Promise<string> {
  if (payload === undefined) return sha256Hex('');
  if (payload === UNSIGNED_PAYLOAD) return UNSIGNED_PAYLOAD;
  if ('sha256Hex' in payload) return payload.sha256Hex;
  return sha256Hex(payload.body);
}

/** `20150830T123600Z` — the ISO instant with its separators and fraction removed. Always UTC. */
const amzDate = (clock: Clock): string =>
  clock
    .now()
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');

/**
 * Sign one request with SigV4 in the `Authorization` header. Returns everything to send — the
 * re-encoded URL and every header — plus the canonical request and string-to-sign for debugging.
 * A malformed input (an empty credential, a scope segment with a `/`, a broken escape) is a coded
 * `X_INVARIANT` refusal before anything is hashed.
 */
export async function signAwsRequest(input: SignAwsRequestInput): Promise<SignedAwsRequest> {
  assertInput(input);
  const url = parseUrl(input.url);
  const service = input.service;
  const path = canonicalPath(url.pathname, input.doubleEncodePath ?? service !== 's3');
  const query = canonicalQuery(url.search);
  const date = amzDate(input.clock ?? systemClock);
  const hash = await payloadHash(input.payload);

  const caller: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (!SIGNER_OWNED.has(name.trim().toLowerCase())) caller[name] = value;
  }
  const hasHost = Object.keys(caller).some((name) => name.trim().toLowerCase() === 'host');
  const token = input.credentials.sessionToken;
  const headers = canonicalHeaders({
    ...caller,
    ...(hasHost ? {} : { host: url.host }),
    'x-amz-date': date,
    ...(token === undefined || token === '' ? {} : { 'x-amz-security-token': token }),
    ...((input.contentSha256Header ?? service === 's3') ? { 'x-amz-content-sha256': hash } : {}),
  });
  const signedHeaders = [...headers.keys()].join(';');
  const canonicalRequest = [
    input.method,
    path,
    query,
    ...[...headers].map(([name, value]) => `${name}:${value}`),
    '',
    signedHeaders,
    hash,
  ].join('\n');

  const day = date.slice(0, 8);
  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, date, scope, await sha256Hex(canonicalRequest)].join('\n');
  let key = encoder.encode(`AWS4${input.credentials.secretAccessKey}`);
  for (const part of [day, input.region, service, 'aws4_request']) key = await hmac(key, part);
  const signature = toHex(await hmac(key, stringToSign));

  const sent = Object.fromEntries(headers);
  sent['authorization'] =
    `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const singlePath = canonicalPath(url.pathname, false);
  return {
    method: input.method,
    url: `${url.origin}${singlePath}${query === '' ? '' : `?${query}`}`,
    headers: sent,
    canonicalRequest,
    stringToSign,
    signature,
  };
}
