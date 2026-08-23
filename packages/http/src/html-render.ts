// The two questions every HTML answer this package renders has to ask, in one place: is the caller
// a browser, and how does a value become markup. Both were the dev overlay's private helpers while
// the production error page needs the identical answers — a second accept sniff would let a client
// get the overlay in dev and JSON in production, and a second escape set is one hole away.

/**
 * `'` is escaped even though every attribute the renderers write is double-quoted: the escape set
 * is what the next author reads as the guarantee, and a single-quoted attribute written later
 * would inherit a hole nothing here would have flagged.
 */
export const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/**
 * Does this caller render HTML? One sniff, three readers — the dev overlay, the production error
 * page and the sign-in redirect — so a browser cannot be handed a page by one of them and a
 * problem document by the next for the same request.
 */
export const acceptsHtml = (request: Request): boolean =>
  (request.headers.get('accept') ?? '').includes('text/html');
