// The coding OFFER: whether an exchange may be answered coded, in which coding, and the validator
// form that offer implies. One decision, read by the coded 200 and by the 304 that revalidates it
// (RFC 9110 §15.4.5) — the 304 carries no length, so the form follows the offer, never the outcome.

/**
 * What the runtime codes natively, best first. Probed on Bun 1.4.4, 2026-11-11, 256 KiB of text:
 * `Bun.zstdCompressSync` level 3 2.9 ms against `Bun.gzipSync` level 6 11.9 ms, sizes within 2%.
 * `br` is not here: Bun's only native brotli is `CompressionStream('brotli')` at quality 11
 * (854 ms per 256 KiB), the rest is `node:zlib`. It belongs to build-time precompression.
 */
export const CONTENT_CODINGS = ['zstd', 'gzip'] as const;

export type ContentCoding = (typeof CONTENT_CODINGS)[number];

/** Text only: images and fonts are coded already, and `text/event-stream` must never be held. */
const COMPRESSIBLE_TYPES: ReadonlySet<string> = new Set([
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/json',
  'application/manifest+json',
  'image/svg+xml',
  'application/xml',
  'text/xml',
  'application/rss+xml',
  'application/atom+xml',
  'text/vtt',
  // Exports and feeds: usually streamed with no declared length, so coded by `codedStream`.
  'application/x-ndjson',
  'text/csv',
]);

/**
 * BREACH: a private document reflects a secret beside attacker input, and a coded length measures
 * how well the two match. `no-cache` is here because it is the one spelling that passes the
 * `cache-headers` review on a signed-in answer without becoming `private`.
 */
const WITHHOLDS_CODING = /(?:^|[\s,])(?:private|no-store|no-cache|no-transform)(?=$|[\s,=])/i;

const IMMUTABLE = /(?:^|[\s,])immutable(?=$|[\s,=])/i;

/**
 * HEAD is GET's headers with no body (RFC 9110 §9.3.2): offered as GET is, so its validator is
 * GET's. Every other method's answer is identity.
 */
const CODED_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/**
 * Whether a `content-type` is one this stage codes. Exported for the one reader that must agree
 * with it: `@ultimat3/cli`'s test holding every public framework route to a declared length.
 */
export const isCompressibleType = (contentType: string | null): boolean => {
  const type = contentType?.split(';')[0]?.trim().toLowerCase();
  return type !== undefined && COMPRESSIBLE_TYPES.has(type);
};

/**
 * A signed-in answer is coded only when `immutable`: a header like `stale-while-revalidate=60`
 * withholds nothing and offers nothing, so the `cache-headers` review leaves it as written, and
 * the body beside it is still the visitor's. The ACTOR is what makes it personal, never the header.
 */
export const compressibleKind = (headers: Headers, anonymous: boolean): boolean => {
  const cacheControl = headers.get('cache-control') ?? '';
  return (
    isCompressibleType(headers.get('content-type')) &&
    !WITHHOLDS_CODING.test(cacheControl) &&
    (anonymous || IMMUTABLE.test(cacheControl))
  );
};

/**
 * RFC 9110 §12.5.3 over `order`, the server's preference: the named coding of highest weight, the
 * order breaking a tie, skipping any `kept` refuses. A `*` is not read as consent to a coding it
 * never named; an unreadable weight is a refusal. The one weight parser: the per-request offer
 * below and the precoded pick (`compress-precode.ts`) differ only in `order` and `kept`.
 */
export const negotiateFrom = <C extends string>(
  header: string | null,
  order: readonly C[],
  kept: (coding: C) => boolean = () => true,
): C | undefined => {
  let best: C | undefined;
  let bestWeight = 0;
  for (const member of header?.split(',') ?? []) {
    const [name = '', ...params] = member.split(';').map((part) => part.trim().toLowerCase());
    const coding = order.find((candidate) => candidate === name);
    if (coding === undefined || !kept(coding)) continue;
    const q = params.find((param) => param.startsWith('q='));
    const weight = q === undefined ? 1 : Number(q.slice(2));
    if (!(weight > 0)) continue;
    const ahead =
      best === undefined ||
      weight > bestWeight ||
      (weight === bestWeight && order.indexOf(coding) < order.indexOf(best));
    if (ahead) {
      best = coding;
      bestWeight = weight;
    }
  }
  return best;
};

/** The coding a request may be answered in, per request: `negotiateFrom` over `CONTENT_CODINGS`. */
export const negotiateCoding = (header: string | null): ContentCoding | undefined =>
  negotiateFrom(header, CONTENT_CODINGS);

/**
 * The coding this exchange is offered, or `undefined`. Read before the status is: the 200 and the
 * 304 for one request get one answer here, whatever either one's body turns out to be.
 */
export const codingOffered = (
  method: string,
  acceptEncoding: string | null,
): ContentCoding | undefined =>
  CODED_METHODS.has(method) ? negotiateCoding(acceptEncoding) : undefined;

/**
 * The validator an answer carries under `offered`. A strong one promises exact bytes, and a client
 * offered a coding may get either set; a weak one over identity bytes is merely less than it could
 * say. So an offer weakens, whether or not this body ends up coded.
 */
export const etagForm = (etag: string, offered: ContentCoding | undefined): string =>
  offered === undefined || etag.startsWith('W/') ? etag : `W/${etag}`;

/** `etagForm` applied in place, to the 200 and the 304 alike. */
export const applyEtagForm = (headers: Headers, offered: ContentCoding | undefined): void => {
  const etag = headers.get('etag');
  if (etag !== null) headers.set('etag', etagForm(etag, offered));
};
