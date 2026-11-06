// What a cassette file holds and how a recorded answer is made safe to hold: response headers on
// an allow-list, credential-named keys masked in JSON bodies and URL queries, sorted keys, and a
// non-text body as base64. The request side is never written — a test asserts it via `requestLog`.

import { assert, isRedactedKey, REDACTED, renderFixShellArg } from '@ultimat3/core';

export const CASSETTE_VERSION = 1;

export interface CassetteEntry {
  readonly method: string;
  /** The URL as the call spelled it, credential-named query values masked. */
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly encoding: 'utf8' | 'base64';
}

export interface CassetteFile {
  readonly version: number;
  readonly entries: readonly CassetteEntry[];
}

/**
 * An ALLOW-list: a deny-list misses the vendor's next header, and a header is where a session
 * cookie or a request id tied to an account rides back.
 */
const KEPT_HEADERS: readonly RegExp[] = [/^content-type$/, /^retry-after$/, /^ratelimit-/];

export const keptHeaders = (headers: Headers): Record<string, string> => {
  const kept: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (KEPT_HEADERS.some((rule) => rule.test(lower))) kept[lower] = value;
  });
  return kept;
};

/** The masked value as a query string carries it. */
const MASKED_QUERY = encodeURIComponent(REDACTED);

/** Each `key=value` whose key names a credential gets the mask; every other byte kept verbatim. */
export function maskUrl(url: string): string {
  const queryAt = url.indexOf('?');
  if (queryAt < 0) return url;
  const hashAt = url.indexOf('#', queryAt);
  const end = hashAt < 0 ? url.length : hashAt;
  const pairs = url.slice(queryAt + 1, end).split('&');
  const masked = pairs.map((pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0) return pair;
    return isRedactedKey(decodeKey(pair.slice(0, eq)))
      ? `${pair.slice(0, eq)}=${MASKED_QUERY}`
      : pair;
  });
  return `${url.slice(0, queryAt + 1)}${masked.join('&')}${url.slice(end)}`;
}

/**
 * The match for a recorded URL: exact where nothing was masked, else a pattern where each mask —
 * a query value, or a `[redacted]` an app's `redact` put in a path — stands for one value, so the
 * replayed request, carrying the real key, still matches.
 */
export function urlMatch(recorded: string): string | RegExp {
  const masks = [MASKED_QUERY, REDACTED];
  if (!masks.some((mask) => recorded.includes(mask))) return recorded;
  const pattern = recorded
    .split(MASKED_QUERY)
    .map((part) => part.split(REDACTED).map(escapeRegExp).join('[^/?&#]*'))
    .join('[^&#]*');
  return new RegExp(`^${pattern}$`);
}

/** A JSON body with every credential-named key's value masked, at any depth; other text as is. */
export function redactBody(text: string, contentType: string | undefined): string {
  if (contentType !== undefined && !/json/i.test(contentType)) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text; // Not JSON: the app's `redact` and the scan are what stand between it and disk.
  }
  return JSON.stringify(masked(parsed));
}

const masked = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(masked);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      isRedactedKey(key) ? REDACTED : masked(child),
    ]),
  );
};

const TEXT_TYPE = /^text\/|json|xml|javascript|x-www-form-urlencoded|event-stream/i;

/** A body as the file holds it: text when it is text, base64 otherwise. */
export function encodeBody(
  bytes: Uint8Array,
  contentType: string | undefined,
): Pick<CassetteEntry, 'body' | 'encoding'> {
  if (contentType === undefined || TEXT_TYPE.test(contentType)) {
    try {
      return { body: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf8' };
    } catch {
      // Labelled text, or unlabelled, that is not UTF-8: keep the bytes, not a lossy decode.
    }
  }
  return { body: Buffer.from(bytes).toString('base64'), encoding: 'base64' };
}

export const decodeBody = (entry: CassetteEntry): Uint8Array<ArrayBuffer> =>
  entry.encoding === 'base64'
    ? Uint8Array.from(Buffer.from(entry.body, 'base64'))
    : new TextEncoder().encode(entry.body);

/** Sorted keys at every depth and a trailing newline: a re-recording diffs by what changed. */
export function serializeCassette(file: CassetteFile): string {
  return `${JSON.stringify(sorted(file), null, 2)}\n`;
}

const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
  );
};

/** The file read back, its shape checked: a hand-edited cassette that broke is named, not replayed. */
export function parseCassette(text: string, file: string): CassetteFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const fix = `rm ${renderFixShellArg(file, '<cassette file>')} && ULTIMATE_CASSETTE=record bun test <test file>`;
  const shaped =
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as { version?: unknown }).version === CASSETTE_VERSION &&
    Array.isArray((parsed as { entries?: unknown }).entries) &&
    (parsed as { entries: unknown[] }).entries.every(isEntry);
  assert(shaped, `${file} is not a version ${CASSETTE_VERSION} cassette`, fix);
  return parsed as CassetteFile;
}

const isEntry = (value: unknown): value is CassetteEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['method'] === 'string' &&
    typeof entry['url'] === 'string' &&
    typeof entry['status'] === 'number' &&
    typeof entry['body'] === 'string' &&
    (entry['encoding'] === 'utf8' || entry['encoding'] === 'base64') &&
    typeof entry['headers'] === 'object' &&
    entry['headers'] !== null
  );
};

function decodeKey(key: string): string {
  try {
    return decodeURIComponent(key.replace(/\+/g, ' '));
  } catch {
    return key;
  }
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
