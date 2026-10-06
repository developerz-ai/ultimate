// The refusals a TRANSPORT raises before dispatch: one message too large for the wire, a caller
// past its rate allowance, an `oauth` block that cannot be published. Split from `errors.ts`,
// which keeps the code registry; this module loads it, so every title is registered first.

import { UltimateError } from '@ultimat3/core';
// why a side-effect import: the codes these classes raise are REGISTERED by `errors.ts`, and a
// process that imports only a transport must still render their titles.
import './errors';

/**
 * One message larger than the transport holds. Its own code, for the reason `X_MCP_RATE_LIMITED`
 * below is not `X_RATE_LIMITED`: `@ultimat3/http`'s `X_BODY_INVALID` names `bodyLimitBytes` on the
 * HTTP pipeline, and this route never passes through it — the knob is `mcpHttpRoute`'s (or
 * `defineAppMcp`'s, which forwards it), and over stdio it is `serveStdio({ lineLimitBytes })`, a
 * ceiling in characters rather than bytes. One class for both transports, because the condition is
 * one: the peer sent more in one message than this end agreed to hold, and the two answers must
 * name the same code so an agent learns it once.
 *
 * Measured through ai-maxxing's `POST /mcp` on 2026-09-07: the 413 was a bare `-32600` reading
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
        : `one message exceeded ${input.limit} characters and was dropped`,
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
