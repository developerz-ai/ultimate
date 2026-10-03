// How a stored object may be presented when the app's own origin serves it (plan 101, s1-sec L6):
// inline only for a type a browser renders without running anything, a sandboxed download otherwise. Read by
// both surfaces that serve stored bytes — `/_storage` (`runtime-storage.ts`) and `/media`.

/**
 * Raster images, audio and video: what an `<img>`, `<audio>` or `<video>` presents and nothing
 * executes. NOT `image/svg+xml` (it carries `<script>`), `text/html`, `application/xml` or PDF —
 * any of them opened from the app's origin runs with the app's cookies and its `'self'` sources.
 */
const INLINE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'video/mp4',
  'video/webm',
  'video/ogg',
]);

/** `image/PNG; charset=…` is `image/png`: parameters and case never widen the list. */
const essenceOf = (contentType: string): string =>
  (contentType.split(';')[0] ?? '').trim().toLowerCase();

export const isInlineSafe = (contentType: string): boolean =>
  INLINE_TYPES.has(essenceOf(contentType));

/**
 * The headers a stored object is served with beyond its type. `attachment` makes a navigation to an
 * uploaded `text/html` a download instead of a page on the app's origin; an embedding element
 * (`<img>`, `<video>`) ignores it, so nothing that displays an object inline stops working. The
 * `sandbox` policy is for the browser that renders it anyway: an opaque origin, no script, no
 * cookies. `@ultimat3/http`'s security stage keeps it and adds the app's policy beside it.
 */
export function storedObjectHeaders(contentType: string): Readonly<Record<string, string>> {
  return isInlineSafe(contentType)
    ? {}
    : { 'content-disposition': 'attachment', 'content-security-policy': 'sandbox' };
}
