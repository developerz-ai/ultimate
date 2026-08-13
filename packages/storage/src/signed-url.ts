// Single responsibility: time-limited signed URLs for direct upload and download.
// The HMAC covers the *constraints* (key, method, expiry, max size, content type), not just
// the key — otherwise a client that receives a URL for a 2MB PNG edits `?x-max=` and uploads
// a 2GB executable. Verification never throws and never short-circuits on expiry before the
// signature, so a forged URL can never learn "the signature was fine, just late".

import { type Clock, systemClock } from '@ultimat3/core';
import type { SignedUrlMethod } from './driver';
import { assertSafeKey, isSafeKey } from './path';

export const SIGNED_URL_VERSION = 'v1';
export const DEFAULT_SIGNED_URL_TTL_MS = 900_000;
/** The dev server mounts the download/upload route here; S3 disks never use it. */
export const DEFAULT_SIGNED_URL_BASE = '/_storage';

export const SIGNED_URL_PARAMS = {
  method: 'x-method',
  expires: 'x-exp',
  maxBytes: 'x-max',
  contentType: 'x-ct',
  signature: 'x-sig',
} as const;

export interface SignedUrlConstraints {
  readonly key: string;
  readonly method: SignedUrlMethod;
  /** Epoch ms. */
  readonly expiresAt: number;
  readonly maxBytes: number | undefined;
  readonly contentType: string | undefined;
}

export interface SignedUrlInput {
  /** Never a literal in app.config.ts — read it from an env var. */
  readonly secret: string;
  readonly key: string;
  readonly method?: SignedUrlMethod | undefined;
  readonly expiresInMs?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly contentType?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly clock?: Clock | undefined;
}

export const SIGNED_URL_FAILURES = [
  'malformed',
  'unsafe-key',
  'signature-mismatch',
  'expired',
] as const;

export type SignedUrlFailure = (typeof SIGNED_URL_FAILURES)[number];

export type SignedUrlVerification =
  | { readonly ok: true; readonly constraints: SignedUrlConstraints }
  | { readonly ok: false; readonly reason: SignedUrlFailure; readonly detail: string };

/** Newline-separated and order-fixed: an ambiguous canonical form is a forgeable one. */
export function canonicalRequest(constraints: SignedUrlConstraints): string {
  return [
    SIGNED_URL_VERSION,
    constraints.method,
    constraints.key,
    String(constraints.expiresAt),
    constraints.maxBytes === undefined ? '' : String(constraints.maxBytes),
    constraints.contentType ?? '',
  ].join('\n');
}

const encoder = new TextEncoder();

export async function signConstraints(
  secret: string,
  constraints: SignedUrlConstraints,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(canonicalRequest(constraints)));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Length is public (fixed-width hex); the byte comparison must not early-exit. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

const trimBase = (base: string): string => base.replace(/\/+$/, '');
const encodeKey = (key: string): string => key.split('/').map(encodeURIComponent).join('/');

export async function buildSignedUrl(input: SignedUrlInput): Promise<string> {
  const key = assertSafeKey(input.key);
  const clock = input.clock ?? systemClock;
  const constraints: SignedUrlConstraints = {
    key,
    method: input.method ?? 'GET',
    expiresAt: clock.now().getTime() + (input.expiresInMs ?? DEFAULT_SIGNED_URL_TTL_MS),
    maxBytes: input.maxBytes,
    contentType: input.contentType,
  };
  const params = new URLSearchParams();
  params.set(SIGNED_URL_PARAMS.method, constraints.method);
  params.set(SIGNED_URL_PARAMS.expires, String(constraints.expiresAt));
  if (constraints.maxBytes !== undefined) {
    params.set(SIGNED_URL_PARAMS.maxBytes, String(constraints.maxBytes));
  }
  if (constraints.contentType !== undefined) {
    params.set(SIGNED_URL_PARAMS.contentType, constraints.contentType);
  }
  params.set(SIGNED_URL_PARAMS.signature, await signConstraints(input.secret, constraints));
  const base = trimBase(input.baseUrl ?? DEFAULT_SIGNED_URL_BASE);
  return `${base}/${encodeKey(key)}?${params.toString()}`;
}

export interface VerifySignedUrlInput {
  /** Absolute or route-relative — both parse. */
  readonly url: string;
  readonly secret: string;
  readonly baseUrl?: string | undefined;
  readonly clock?: Clock | undefined;
}

const fail = (reason: SignedUrlFailure, detail: string): SignedUrlVerification => ({
  ok: false,
  reason,
  detail,
});

/**
 * `undefined` instead of the bare `URIError` `decodeURIComponent('%ZZ')` throws. The URL is
 * attacker-supplied and the header's promise is that verification never throws — an exception
 * here would escape as an uncoded 500 for a caller whose URL is simply malformed. Nothing is
 * loosened: `buildSignedUrl` percent-encodes every segment, so a segment that will not decode
 * was never minted by this package.
 */
const decodeSegment = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

function parseConstraints(url: URL, base: string): SignedUrlConstraints | SignedUrlFailure {
  if (!url.pathname.startsWith(`${base}/`)) return 'malformed';
  const segments = url.pathname
    .slice(base.length + 1)
    .split('/')
    .map(decodeSegment);
  if (segments.includes(undefined)) return 'malformed';
  const key = segments.join('/');
  if (!isSafeKey(key)) return 'unsafe-key';
  const method = url.searchParams.get(SIGNED_URL_PARAMS.method) ?? 'GET';
  if (method !== 'GET' && method !== 'PUT') return 'malformed';
  const expiresAt = Number(url.searchParams.get(SIGNED_URL_PARAMS.expires));
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return 'malformed';
  const rawMax = url.searchParams.get(SIGNED_URL_PARAMS.maxBytes);
  const maxBytes = rawMax === null ? undefined : Number(rawMax);
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    return 'malformed';
  }
  return {
    key,
    method,
    expiresAt,
    maxBytes,
    contentType: url.searchParams.get(SIGNED_URL_PARAMS.contentType) ?? undefined,
  };
}

export async function verifySignedUrl(input: VerifySignedUrlInput): Promise<SignedUrlVerification> {
  let url: URL;
  try {
    url = new URL(input.url, 'http://storage.invalid');
  } catch {
    return fail('malformed', `${input.url} is not a URL`);
  }
  const signature = url.searchParams.get(SIGNED_URL_PARAMS.signature);
  if (signature === null) return fail('malformed', `no ${SIGNED_URL_PARAMS.signature} parameter`);
  const parsed = parseConstraints(url, trimBase(input.baseUrl ?? DEFAULT_SIGNED_URL_BASE));
  if (typeof parsed === 'string') return fail(parsed, `${url.pathname} is not a signable request`);

  const expected = await signConstraints(input.secret, parsed);
  if (!timingSafeEqual(expected, signature)) {
    return fail('signature-mismatch', 'the constraints do not match the signature');
  }
  const now = (input.clock ?? systemClock).now().getTime();
  if (now > parsed.expiresAt) {
    return fail('expired', `expired ${now - parsed.expiresAt}ms ago`);
  }
  return { ok: true, constraints: parsed };
}
