// Single responsibility: the constraint policy for direct-to-storage uploads — size,
// allowlist, checksum — and the content-type sniff that enforces it.
// WHY sniff: `Content-Type` is attacker-controlled. A `.png` that is really an HTML document
// is a stored-XSS delivery vehicle the moment any surface serves it back with the declared
// type, so the magic bytes decide and a contradiction is rejected outright — including the
// contradiction of NO answer at all, where the declared type is one a signature could have
// confirmed. A type no rule can ever confirm (`text/csv`, `application/json`) is still accepted
// on the client's word: there is nothing to compare it against.

import { finiteCount } from '@ultimat3/core';
import { sha256Base64 } from './driver';
import {
  checksumMismatch,
  contentTypeMismatch,
  contentTypeNotAllowed,
  contentTypeUnrecognised,
  tooLarge,
  xmlBodyUnreadable,
} from './errors';
import { HEIF_CONTAINER, ISO_BMFF_CONTAINER, ISO_BMFF_TYPES, sniffIsoBmff } from './iso-bmff';
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
    // `=== undefined`, never `??`: `??` coalesces on `null` too, so an explicitly blanked key in
    // a decoded JSON config took the default instead of the refusal beside it.
    maxBytes: finiteCount(
      'uploadPolicy',
      'maxBytes',
      init.maxBytes === undefined ? DEFAULT_MAX_UPLOAD_BYTES : init.maxBytes,
      1,
    ),
    // Normalised, because the declared type is: `validateUpload` and `grantUpload` compare the
    // NORMALISED declaration against this list, so an allowlist spelling an alias (`image/jpg`,
    // `audio/x-m4a`) named a type no upload could ever match.
    allowedContentTypes: (init.allowedContentTypes ?? IMAGE_CONTENT_TYPES).map(
      normalizeContentType,
    ),
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
  if (head.startsWith('<')) return activeMarkupType(text) ?? 'text/plain';
  return 'text/plain';
}

/**
 * `&#58;` and `&#x3a;` are `:` to an XML parser, so they are `:` to the scan below too. The digit
 * run is UNBOUNDED because XML puts no cap on leading zeros (`&#x000000003a;` is `:`); the range is
 * checked on the value instead, and a reference past U+10FFFF stays as written, as it is not a
 * character a parser would produce.
 */
const decodeCharacterReferences = (text: string): string =>
  text.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (whole, ref: string) => {
    const hex = ref[0] === 'x' || ref[0] === 'X';
    const digits = (hex ? ref.slice(1) : ref).replace(/^0+(?=.)/, '');
    if (digits.length > (hex ? 6 : 7)) return whole;
    const code = Number.parseInt(digits, hex ? 16 : 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
/** XHTML elements and XSLT output are pages; a DTD's entities can assemble either out of parts. */
const PAGE_MARKERS = [
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/1999/xsl/transform',
  '<?xml-stylesheet',
  '<!entity',
] as const;

/**
 * Whether markup that looked like plain text is a document a browser RUNS — asked of the WHOLE
 * body, never its head, because XML puts no rule on where a namespace is declared. Under
 * `application/xml` a browser executes an XHTML-namespaced `<script>` anywhere in the tree, an
 * SVG-namespaced element likewise, and an `<?xml-stylesheet?>` makes the document whatever HTML
 * its XSLT emits. An internal `<!ENTITY>` subset is refused with them: an entity expands inside
 * an attribute value, so it can build a namespace out of two halves no substring scan can see.
 * A data document — a namespace of its own, no DTD, no stylesheet — stays plain text.
 */
function activeMarkupType(text: string): 'text/html' | 'image/svg+xml' | undefined {
  const scanned = decodeCharacterReferences(text).toLowerCase();
  if (PAGE_MARKERS.some((marker) => scanned.includes(marker))) return 'text/html';
  return scanned.includes(SVG_NAMESPACE) ? 'image/svg+xml' : undefined;
}

/** `undefined` means "no rule recognised it", never "it is fine". */
export function sniffContentType(bytes: Uint8Array): string | undefined {
  for (const rule of MAGIC_RULES) {
    if (matches(bytes, rule)) return rule.type;
  }
  // Not a `MagicRule`: every ISO base media file opens with the same `ftyp` box, and the one rule
  // that matched it labelled AVIF, HEIC, MOV and M4A all `video/mp4`. The major brand decides.
  return sniffIsoBmff(bytes) ?? sniffText(bytes);
}

// A `Map`, not an object literal: `base` is the transport's own `Content-Type` header by the time
// `acceptSignedUpload` reaches here, and `ALIASES['constructor']` on an object answers the `Object`
// FUNCTION through a `: string` signature — which the refusal below then rendered as its `cause`.
const ALIASES: ReadonlyMap<string, string> = new Map([
  ['image/jpg', 'image/jpeg'],
  ['image/x-png', 'image/png'],
  ['application/x-pdf', 'application/pdf'],
  // What Chrome and Safari report for an `.m4a` / `.m4v` picked from disk.
  ['audio/x-m4a', 'audio/mp4'],
  ['audio/m4a', 'audio/mp4'],
  ['video/x-m4v', 'video/mp4'],
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

// A brand that names only the container: `isom` is on an audio-only MP4 as often as on a video,
// and `mif1` on a still HEIC and a still AVIF alike. `image/heif` is also the general name of a
// file whose brand says `heic`, so that pair matches in the other direction too.
const MP4_CONTAINED = new Set(['audio/mp4']);
const HEIF_CONTAINED = new Set(['image/heic', 'image/avif']);

/**
 * A generic sniff (zip container, ISO-BMFF container, plain text) may stand in for a specific
 * declared type.
 */
export function contentTypeMatches(declared: string, sniffed: string): boolean {
  const type = normalizeContentType(declared);
  if (type === sniffed) return true;
  if (sniffed === 'application/zip') return ZIP_CONTAINERS.has(type);
  if (sniffed === ISO_BMFF_CONTAINER) return MP4_CONTAINED.has(type);
  if (sniffed === HEIF_CONTAINER) return HEIF_CONTAINED.has(type);
  if (sniffed === 'image/heic') return type === HEIF_CONTAINER;
  if (sniffed === 'text/plain') return TEXT_FAMILY.has(type);
  return false;
}

/**
 * Whether the magic bytes could ever CONFIRM this declared type — the question a `undefined`
 * sniff has to be read against. Through `contentTypeMatches` rather than an equality on
 * `rule.type`, so the zip containers ride along: no rule names a `.docx`, but every OOXML
 * document is a zip and `application/zip` is a rule, so an unrecognisable body under that type is
 * as provably wrong as one under `image/png`.
 */
function hasSignature(declared: string): boolean {
  return (
    MAGIC_RULES.some((rule) => contentTypeMatches(declared, rule.type)) ||
    ISO_BMFF_TYPES.some((type) => contentTypeMatches(declared, type))
  );
}

/** `application/xml`, `text/xml` and every `+xml` suffix type (RFC 6839): what a browser parses as XML. */
const isXmlType = (type: string): boolean =>
  type === 'application/xml' || type === 'text/xml' || type.endsWith('+xml');

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
  if (sniffed === undefined) {
    // `undefined` is "no rule recognised it", never "it is fine" — `sniffContentType`'s own doc
    // says so and this branch read it the other way, so any body the sniffer bailed on (one
    // control byte, one non-UTF-8 sequence) skipped the guard entirely. Measured: an HTML
    // document with a trailing `0x01` was accepted as `image/png`.
    //
    // An XML type is refused the same way, though no signature names it: a browser decodes XML by
    // its BOM or `encoding=` declaration (UTF-16, a legacy charset) and runs the XHTML or SVG it
    // finds, so a body the sniffer could not read as UTF-8 text is one whose script it never saw.
    // Plain text types (`text/csv`) stay accepted: a Latin-1 CSV is real, and nothing executes it.
    if (hasSignature(declared)) throw contentTypeUnrecognised(key, declared);
    if (isXmlType(declared)) throw xmlBodyUnreadable(key, declared);
  } else if (!contentTypeMatches(declared, sniffed)) {
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
