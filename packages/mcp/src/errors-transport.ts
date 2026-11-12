// The refusals a TRANSPORT raises before dispatch: one message too large for the wire, a caller
// past its rate allowance, an `oauth` block that cannot be published, a protocol version or a
// mirrored header the request got wrong, a cross-origin page. Split from `errors.ts`,
// which keeps the code registry; this module loads it, so every title is registered first.

import { renderFixShellArg, UltimateError } from '@ultimat3/core';
// why a side-effect import: the codes these classes raise are REGISTERED by `errors.ts`, and a
// process that imports only a transport must still render their titles.
import './errors';

/**
 * One message larger than the transport holds. Its own code, for the reason `X_MCP_RATE_LIMITED`
 * below is not `X_RATE_LIMITED`: `@ultimat3/http`'s `X_BODY_INVALID` names `bodyLimitBytes` on the
 * HTTP pipeline, and this route never passes through it — the knob is `mcpHttpRoute`'s (or
 * `defineAppMcp`'s, which forwards it), and over stdio it is `serveStdio({ lineLimitBytes })`, a
 * ceiling in bytes of one line (in characters until 31.7). One class for both transports, because the condition is
 * one: the peer sent more in one message than this end agreed to hold, and the two answers must
 * name the same code so an agent learns it once.
 *
 * Measured through one adopter's `POST /mcp` on 2026-09-07: the 413 was a bare `-32600` reading
 * `request body is at least N bytes, limit is M` — two numbers and no next step, while the 401,
 * 403 and 429 beside it all carried `{ code, cause, fix }`. A box agent sending a large
 * `promptSession` had nothing to act on. The fix names both moves, send less or raise the cap,
 * because which one is right is the author's call: a prompt can be split, a paged result cannot
 * always be, and a cap set by default was never a decision anyone made about this app.
 */
export class McpBodyTooLargeError extends UltimateError {
  readonly limit: number;

  constructor(input: { transport: 'http' | 'stdio'; limit: number; over?: number | undefined }) {
    const http = input.transport === 'http';
    // A NUMBER in the fix, never a `<n>`: the contract is a one-line edit that runs as written. The
    // cap itself would run and change nothing; twice the larger of the cap and what arrived is a
    // value that admits this message, whichever of the two was the shorter measure. Both are
    // finite non-negative integers by the transports' own screens, so the product is too.
    const raised = 2 * Math.max(input.limit, input.over ?? 0);
    super({
      code: 'X_MCP_BODY_TOO_LARGE',
      cause: http
        ? `request body is at least ${input.over ?? input.limit} bytes, limit is ${input.limit}`
        : `one message exceeded ${input.limit} bytes and was dropped`,
      fix: http
        ? `send less in one request — page a large read, split a long prompt across calls — or raise the cap where the route is built: mcpHttpRoute({ bodyLimitBytes: ${raised} }) or defineAppMcp({ bodyLimitBytes: ${raised} })`
        : `send one JSON-RPC message per line, each under the cap — split a large tool result into paged calls — or raise it where the transport is started: serveStdio({ lineLimitBytes: ${raised} })`,
      // The numbers as FIELDS, not only prose: a `--json` reader and the wire's `data` both want
      // the limit without re-parsing a sentence.
      meta: {
        transport: input.transport,
        limit: input.limit,
        ...(input.over === undefined ? {} : { over: input.over }),
      },
    });
    this.limit = input.limit;
  }
}

/**
 * The transport's own throttle, and its own CODE rather than `@ultimat3/http`'s `X_RATE_LIMITED`
 * — not because the maths differ (they are the same `Bucket`, the same store and the same
 * `rateLimitDecision`) but because the KNOB does. `X_RATE_LIMITED` tells an operator to raise
 * `rateLimit.buckets` through `configureHttp()`, which governs the HTTP pipeline and not this route: all
 * MCP traffic is one URL and the class comes from the parsed body, so `mcpHttpRoute` meters itself.
 * A fix line that runs and changes nothing is worse than none — the same rule
 * `@ultimat3/realtime`'s `SubscriptionLimitError` follows when it names the knob over the default.
 *
 * The bucket key names the ACTOR and never reaches the caller: a 429 is provokable by anyone
 * holding a valid token, and an org id or an actor id in the body of one is a leak wearing a
 * throttle's clothes.
 */
export class McpRateLimitedError extends UltimateError {
  constructor(input: { verbClass: string; limit: number; retryAfterSeconds: number }) {
    super({
      code: 'X_MCP_RATE_LIMITED',
      cause: `this caller has spent its ${input.limit} ${input.verbClass} requests per minute; the bucket refills in ${input.retryAfterSeconds}s`,
      fix: `wait ${input.retryAfterSeconds}s — the Retry-After header carries the same number — or raise it where the route is built: mcpHttpRoute({ rateLimits: { ${input.verbClass}: <n> } }), or defineAppMcp({ rateLimits })`,
      // why `meta` and not only the sentence: `transport-http.ts` writes `Retry-After` by hand, so
      // this route is correct today. `@ultimat3/http`'s `retryAfterOf` reads the header off
      // `meta.retryAfterSeconds` — so the day an MCP host is mounted inside that pipeline, an error
      // carrying the number only in its prose sheds a caller with no delay to honour, which is the
      // stampede `admit` exists to spread.
      meta: { retryAfterSeconds: input.retryAfterSeconds },
    });
  }
}

/** `defineAppMcp({ oauth })` refused at boot — see `oauth-metadata.ts`. */
export class McpOAuthInvalidError extends UltimateError {
  constructor(reason: string) {
    super({
      code: 'X_MCP_OAUTH_INVALID',
      cause: `defineAppMcp({ oauth }) cannot be published as protected-resource metadata: ${reason}`,
      fix: "defineAppMcp({ ..., oauth: { authorizationServers: ['https://www.example.com'] } }) — at least one absolute https (or http://localhost) issuer URL; resource and resourceDocumentation, when set, absolute URLs with no fragment",
    });
  }
}

/**
 * A request naming a revision this server does not serve — MCP's `UnsupportedProtocolVersionError`
 * (`-32022`, HTTP 400). `supported` travels as data so a modern client retries without a human: a
 * dual-era client that reads this body knows the server is modern and stays modern.
 */
export class McpProtocolUnsupportedError extends UltimateError {
  constructor(input: { requested: string | null; supported: readonly string[] }) {
    super({
      code: 'X_MCP_PROTOCOL_UNSUPPORTED',
      cause:
        input.requested === null
          ? 'the request names its protocol version with a value that is not a string'
          : `the request names protocol version "${input.requested}", which this server does not serve`,
      fix: `{ "_meta": { "io.modelcontextprotocol/protocolVersion": "${input.supported[0] ?? ''}" } } in params, with the MCP-Protocol-Version header equal to it; served: ${input.supported.join(', ')}`,
      meta: { supported: input.supported, requested: input.requested },
    });
  }
}

/** The mirrored request headers, by the body field each must equal. */
export type McpMirroredHeader = 'MCP-Protocol-Version' | 'Mcp-Method' | 'Mcp-Name';

/**
 * A modern request whose mirrored header is absent or disagrees with its body — MCP's
 * `HeaderMismatch` (`-32020`, HTTP 400). Refused because a load balancer may route on the header
 * while this server runs the body. The header's VALUE is never echoed: it is the caller's input.
 */
export class McpHeaderMismatchError extends UltimateError {
  constructor(input: { header: McpMirroredHeader; absent: boolean }) {
    super({
      code: 'X_MCP_HEADER_MISMATCH',
      cause: input.absent
        ? `the ${input.header} header is absent from a request that carries a protocol version in _meta`
        : `the ${input.header} header does not equal the body's ${BODY_FIELD[input.header]}`,
      fix: `{ "MCP-Protocol-Version": "<params._meta version>", "Mcp-Method": "<method>", "Mcp-Name": "<params.name or params.uri>" } as the request headers — ${input.header} equal to the body's ${BODY_FIELD[input.header]}, a non-ASCII Mcp-Name as =?base64?<utf-8 base64>?=`,
      meta: { header: input.header },
    });
  }
}

const BODY_FIELD: Readonly<Record<McpMirroredHeader, string>> = {
  'MCP-Protocol-Version': 'params._meta["io.modelcontextprotocol/protocolVersion"]',
  'Mcp-Method': 'method',
  'Mcp-Name': 'params.name or params.uri',
};

/**
 * A request carrying an `Origin` that core's `proveSameOrigin` cannot show is this app's — not the
 * route's own public origin, not listed in `http.cors.origins` — refused 403 before the token is read
 * (MCP Streamable HTTP: "If the Origin header is present and invalid, servers MUST respond with
 * HTTP 403"). It does NOT catch a DNS-rebound name: that page's Host and Origin agree, so a server
 * that serves only this machine refuses the Host first (`X_MCP_HOST_REFUSED`).
 */
export class McpOriginRefusedError extends UltimateError {
  constructor(input: { reason: string; endpoint: string }) {
    super({
      code: 'X_MCP_ORIGIN_REFUSED',
      cause: `a browser page called POST /mcp and could not be shown to be this app: ${input.reason}`,
      fix: `curl -X POST ${renderFixShellArg(input.endpoint, 'http://localhost:3000/mcp')} -H 'authorization: Bearer <token>' — no Origin header; a page on a sibling origin is listed in http.cors.origins`,
    });
  }
}

/**
 * A request naming a Host that is not this machine, on a server that only ever serves this machine
 * (`x mcp serve`). The `Origin` cannot carry this check: a DNS-rebound page's Host and Origin agree.
 * The host decides what is loopback (the CLI's `isLoopbackHostname`, `/_x`'s rule); this renders it.
 * Never echoes the Host it was sent.
 */
export class McpHostRefusedError extends UltimateError {
  constructor(input: { endpoint: string }) {
    super({
      code: 'X_MCP_HOST_REFUSED',
      cause:
        'the request named a Host that is not localhost, a *.localhost name or a loopback address — the shape of a DNS-rebinding page, whose Host and Origin agree',
      fix: `curl -X POST ${renderFixShellArg(input.endpoint, 'http://localhost:9229/mcp')} -H 'authorization: Bearer <token>'`,
    });
  }
}
