// Single responsibility: the constraint policy for direct-to-storage uploads — size,
// allowlist, checksum — and the content-type sniff that enforces it.
// WHY sniff: `Content-Type` is attacker-controlled. A `.png` that is really an HTML document
// is a stored-XSS delivery vehicle the moment any surface serves it back with the declared
// type, so the magic bytes decide and a contradiction is rejected outright.

import { finiteCount } from '@ultimat3/core';
import { sha256Base64 } from './driver';
import { checksumMismatch, contentTypeMismatch, contentTypeNotAllowed, tooLarge } from './errors';
import { assertSafeKey } from './path';

export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * `image/svg+xml` is deliberately ABSENT, and this is the default `uploadPolicy()` allowlist. An
 * SVG is a script document: served back from the app's own origin under its declared type it runs
 * on that origin, and the sniffer below PROMOTES a `<svg` body to this type rather than refusing
 * it — so every app taking the default was accepting stored XSS, cached by the asset route for a
 * year. An app that genuinely serves user SVG declares it once, explicitly, in
 * `uploadPolicy({ allowedContentTypes })`, having decided how it serves the bytes back.
 */
export const IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export const DOCUMENT_CONTENT_TYPES = [
  'application/pdf',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;

export interface UploadPolicy {
  readonly maxBytes: number;
  readonly allowedContentTypes: readonly string[];
  /** When true a candidate without a `checksum` is rejected, not silently trusted. */
  readonly requireChecksum: boolean;
}

export interface UploadPolicyInit {
  readonly maxBytes?: number | undefined;
  readonly allowedContentTypes?: readonly string[] | undefined;
  readonly requireChecksum?: boolean | undefined;
}

export function uploadPolicy(init: UploadPolicyInit = {}): UploadPolicy {
  return {
    // Screened where it is DECLARED, because every reader of it is a comparison: `size >
    // policy.maxBytes` is false for a `NaN` ceiling, so the cap that decides how much a caller may
    // store stops deciding anything. Measured: a 5,000,016-byte PNG passed `validateUpload` under
    // `uploadPolicy({ maxBytes: Number.NaN })`.
    maxBytes: finiteCount('uploadPolicy', 'maxBytes', init.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES, 1),
    allowedContentTypes: init.allowedContentTypes ?? IMAGE_CONTENT_TYPES,
    requireChecksum: init.requireChecksum ?? false,
  };
}

export interface UploadCandidate {
  readonly key: string;
  /** Whatever the client claimed. Trusted for nothing except the error message. */
  readonly declaredContentType: string;
  readonly bytes: Uint8Array;
  /** base64 SHA-256. */
  readonly checksum?: string | undefined;
}

export interface ValidatedUpload {
  readonly key: string;
  /** Safe to serve: the declared type, but only after the magic bytes agreed with it. */
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly checksum: string;
}

interface MagicRule {
  readonly type: string;
  readonly parts: readonly { readonly offset: number; readonly pattern: readonly number[] }[];
}

const ascii = (text: string): readonly number[] => [...text].map((char) => char.charCodeAt(0));

const MAGIC_RULES: readonly MagicRule[] = [
  {
    type: 'image/png',
    parts: [{ offset: 0, pattern: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  },
  { type: 'image/jpeg', parts: [{ offset: 0, pattern: [0xff, 0xd8, 0xff] }] },
  { type: 'image/gif', parts: [{ offset: 0, pattern: ascii('GIF87a') }] },
  { type: 'image/gif', parts: [{ offset: 0, pattern: ascii('GIF89a') }] },
  {
    type: 'image/webp',
    parts: [
      { offset: 0, pattern: ascii('RIFF') },
      { offset: 8, pattern: ascii('WEBP') },
    ],
  },
  { type: 'application/pdf', parts: [{ offset: 0, pattern: ascii('%PDF-') }] },
  { type: 'video/mp4', parts: [{ offset: 4, pattern: ascii('ftyp') }] },
  // Every OOXML document and epub is a zip; the container is as far as magic bytes go.
  { type: 'application/zip', parts: [{ offset: 0, pattern: [0x50, 0x4b, 0x03, 0x04] }] },
];

const matches = (bytes: Uint8Array, rule: MagicRule): boolean =>
  rule.parts.every((part) =>
    part.pattern.every((byte, index) => bytes[part.offset + index] === byte),
  );

function sniffText(bytes: Uint8Array): string | undefined {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const printable = code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
    if (!printable) return undefined;
  }
  const head = text.slice(0, 512).trimStart().toLowerCase();
  if (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.startsWith('<head') ||
    head.startsWith('<script') ||
    head.startsWith('<body')
  ) {
    return 'text/html';
  }
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return 'image/svg+xml';
  }
  return 'text/plain';
}

/** `undefined` means "no rule recognised it", never "it is fine". */
export function sniffContentType(bytes: Uint8Array): string | undefined {
  for (const rule of MAGIC_RULES) {
    if (matches(bytes, rule)) return rule.type;
  }
  return sniffText(bytes);
}

// A `Map`, not an object literal: `base` is the transport's own `Content-Type` header by the time
// `acceptSignedUpload` reaches here, and `ALIASES['constructor']` on an object answers the `Object`
// FUNCTION through a `: string` signature — which the refusal below then rendered as its `cause`.
const ALIASES: ReadonlyMap<string, string> = new Map([
  ['image/jpg', 'image/jpeg'],
  ['image/x-png', 'image/png'],
  ['application/x-pdf', 'application/pdf'],
]);

/** Strip parameters and case: `IMAGE/PNG; charset=binary` and `image/png` are one type. */
export function normalizeContentType(value: string): string {
  const base = (value.split(';')[0] ?? '').trim().toLowerCase();
  return ALIASES.get(base) ?? base;
}

const ZIP_CONTAINERS = new Set<string>([...DOCUMENT_CONTENT_TYPES, 'application/epub+zip']);
const TEXT_FAMILY = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/xml',
  'text/xml',
]);

/** A generic sniff (zip container, plain text) may stand in for a specific declared type. */
export function contentTypeMatches(declared: string, sniffed: string): boolean {
  const type = normalizeContentType(declared);
  if (type === sniffed) return true;
  if (sniffed === 'application/zip') return ZIP_CONTAINERS.has(type);
  if (sniffed === 'text/plain') return TEXT_FAMILY.has(type);
  return false;
}

/**
 * Throws the first violated constraint, in this order: key, size, type, checksum. The key comes
 * before the size because a key nothing may store makes the other three moot, and which
 * constraint a rejected upload reports is what the client retries on — `upload.test.ts` pins it.
 */
export function validateUpload(
  candidate: UploadCandidate,
  policy: UploadPolicy = uploadPolicy(),
): ValidatedUpload {
  const key = assertSafeKey(candidate.key);
  const size = candidate.bytes.byteLength;
  if (size > policy.maxBytes) throw tooLarge(key, size, policy.maxBytes);

  const declared = normalizeContentType(candidate.declaredContentType);
  if (!policy.allowedContentTypes.includes(declared)) {
    throw contentTypeNotAllowed(key, declared, policy.allowedContentTypes);
  }
  const sniffed = sniffContentType(candidate.bytes);
  if (sniffed !== undefined && !contentTypeMatches(declared, sniffed)) {
    throw contentTypeMismatch(key, declared, sniffed);
  }

  const checksum = sha256Base64(candidate.bytes);
  const claimed = candidate.checksum;
  if (claimed !== undefined && claimed !== checksum) throw checksumMismatch(key, claimed, checksum);
  if (claimed === undefined && policy.requireChecksum) {
    throw checksumMismatch(key, 'none', checksum);
  }
  return { key, contentType: declared, bytes: candidate.bytes, size, checksum };
}
