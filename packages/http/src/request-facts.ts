// How one request arrived, as the frozen facts a token resolver is handed — never the raw
// `Headers`. A resolver given the headers would read `x-forwarded-for` itself and trust a hop the
// host never declared; the address here is the one the pipeline already resolved (`ctx.ip`).
// One shape for every bearer surface: this mount, and `@ultimat3/mcp`'s `POST /mcp`.

/**
 * The request, as far as a credential decision may read it. Four facts and no more: a token bound
 * to a network reads `address`, a resolver refusing browsers reads `origin`. Never the body (it is
 * unread when the token is decided) and never another header — `Authorization` is the token itself.
 */
export interface RequestFacts {
  /**
   * The caller's address AS THE HOST RESOLVED IT — `ctx.ip`, a declared proxy's `x-forwarded-for`
   * honoured per `trustedProxyHops`, else the socket. `null` when the host resolved none: a surface
   * that cannot tell a trusted hop from a forged one never derives one from a header.
   */
  readonly address: string | null;
  /** `User-Agent`, verbatim — caller-controlled, so a hint for a rule and never an identity. */
  readonly userAgent: string | null;
  /**
   * The `Origin` request header: which web origin a BROWSER says is calling. `null` when absent —
   * every non-browser client — and the literal string `'null'` for an opaque origin, which is a
   * different fact (a sandboxed frame or a `file:` page) and must not read as "no browser".
   */
  readonly origin: string | null;
  /** The URL path the request was sent to. No query string. */
  readonly path: string;
}

export interface RequestFactsInput {
  readonly headers: Headers;
  readonly url: URL | string;
  /** What the host resolved — `ctx.ip`, or a transport's `seen.address`. Never a header read. */
  readonly address: string | null | undefined;
}

export function requestFacts(input: RequestFactsInput): RequestFacts {
  return Object.freeze({
    address: input.address ?? null,
    userAgent: input.headers.get('user-agent'),
    origin: input.headers.get('origin'),
    path: (typeof input.url === 'string' ? new URL(input.url) : input.url).pathname,
  });
}
