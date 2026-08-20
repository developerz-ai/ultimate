// Single responsibility: the one injectable HTTP call every transport in this package takes.
//
// Shared by all three rather than declared three times: both chat providers and the embedder hand
// a URL and a `RequestInit` to something that answers a `Response`, and three separate spellings
// of that is three places a test double has to be kept assignable to.

/**
 * Just the call. `typeof fetch` also carries `preconnect`, which no test double should have to —
 * and none can supply, so every fake written against `typeof fetch` here needed
 * `as unknown as typeof fetch` to compile: an option no caller could fill without a double cast.
 *
 * The same seam `@ultimat3/cache` (`PurgeFetch`), `@ultimat3/auth` (`OAuthFetch`),
 * `@ultimat3/mail` (`MailFetch`) and `@ultimat3/scraping` (`ScrapeFetch`) already name.
 */
export type AiFetch = (input: string, init: RequestInit) => Promise<Response>;
