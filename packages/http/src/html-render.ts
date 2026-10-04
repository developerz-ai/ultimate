// Is the caller a browser? One sniff for every HTML answer this package renders — the dev overlay
// and the production error page need the identical answer, and a second sniff would let a client
// get the overlay in dev and JSON in production. How a value becomes markup is core's `escapeHtml`.

/**
 * Does this caller render HTML? One sniff, three readers — the dev overlay, the production error
 * page and the sign-in redirect — so a browser cannot be handed a page by one of them and a
 * problem document by the next for the same request.
 */
export const acceptsHtml = (request: Request): boolean =>
  (request.headers.get('accept') ?? '').includes('text/html');
