// `POST /mcp` — the HTTP transport.
//
// Exported as a route DESCRIPTOR rather than a mounted handler: a host owns the lifecycle (ALS
// context, tracing) and mounts this, while the descriptor stays drivable from a bare `Request` in
// a test. Three things travel with it that a generic route table cannot infer:
//
//  1. `rateLimitClass(body)` — all MCP traffic is one URL, so a per-route bucket would
//     charge `initialize` and every read to the write bucket and throttle an agent on its
//     handshake. The server classifies each body instead.
//  2. `limits`, ENFORCED HERE since 2026-08-24 and by nothing before it. The two above were
//     published on the descriptor and read by no mount point: `x mcp serve` runs `handle` in a
//     bare `Bun.serve` and `defineAppMcp` returns the route to the app, so the type promised 20
//     writes a minute and the real ceiling was Bun's accept rate. It cannot be enforced from
//     OUTSIDE either: `rateLimitClass(body)` takes an already-parsed body and `handle` is the only
//     thing that parses one, so a limiter above it would have to consume the request stream first.
//     The maths, the `Bucket` and the store are `@ultimat3/http`'s — tier 2, a downward import,
//     and never a second token bucket written here.
//  3. `authenticate` — a bearer token resolves to an Actor of kind 'agent'. An agent is
//     never silently upgraded to the user behind the token; policies see 'agent' and can
//     refuse what a human would be allowed.

import type { Actor, Clock } from '@ultimat3/core';
import { finiteCount, readWithinLimit, systemClock } from '@ultimat3/core';
import type { RequestFacts as McpRequestFacts, RateLimitStore } from '@ultimat3/http';
import { memoryRateLimitStore, requestFacts, toBucket } from '@ultimat3/http';
import { McpBodyTooLargeError } from './errors-transport';
import type { McpOAuth } from './oauth-metadata';
import {
  assertMcpOAuth,
  assertScopeTokens,
  bearerChallenge,
  metadataPaths,
  metadataUrlFor,
  protectedResourceMetadata,
  resourceUrl,
  supportedScopes,
} from './oauth-metadata';
import { headerRefusal, httpStatusOf } from './protocol-era';
import type { McpCaller, McpRole, McpVerbClass } from './registry';
import type { McpServer } from './server';
import {
  failureMeter,
  json,
  NO_STORE_HEADERS,
  notAnAgent,
  originRefusal,
  throttled,
  unauthorized,
} from './transport-http-answers';
import { errorResponse, INVALID_REQUEST, PARSE_ERROR, refusalMessage } from './wire';

/**
 * The same 1 MiB `@ultimat3/http`'s `bodyLimitBytes` defaults to. This descriptor is driven from a
 * bare `Request` and never passes through that pipeline, so without a cap here Bun's 128 MiB
 * default was the only ceiling — and `x mcp serve` and `httpServer` both pass no
 * `maxRequestBodySize`.
 */
export const DEFAULT_MCP_BODY_LIMIT_BYTES = 1_048_576;

/** The window every number in `MCP_RATE_LIMITS` is spent over. One minute, per class, per actor. */
export const MCP_RATE_LIMIT_WINDOW_MS = 60_000;

/** Requests per minute per caller, by class. Reads are cheap; a write may run migrations. */
export const MCP_RATE_LIMITS: Readonly<Record<McpVerbClass, number>> = {
  read: 120,
  write: 20,
};

/**
 * Failed authentications per minute per ADDRESS. An address past it is refused before
 * `resolveToken` runs, so guessing tokens is bounded and a valid guess is answered the same 429.
 */
export const MCP_UNAUTHENTICATED_LIMIT = 20;

/** `rateLimits` as declared: the two per-actor classes, and the per-address failure allowance. */
export type McpRateLimits = Readonly<Record<McpVerbClass, number>> & {
  /** Failed authentications per minute per address. Defaults to `MCP_UNAUTHENTICATED_LIMIT`. */
  readonly unauthenticated?: number | undefined;
};

/** What a token resolves to. `null` = unauthenticated, answered 401 with no catalog. */
export interface ResolvedToken {
  readonly actor: Actor;
  readonly scopes: ReadonlySet<string>;
  readonly role?: McpRole;
}

export interface McpHttpTransportInput {
  readonly server: McpServer;
  /**
   * Resolve an OAuth bearer / personal token to a caller. The framework supplies the token and
   * how the request arrived (`McpRequestFacts`: the host-resolved address, user agent, `Origin`,
   * path) — so a token can be bound to a network or refused from a browser origin. Credential
   * storage belongs to `@ultimat3/policy` and the app, never here. A one-argument resolver is
   * still one: the facts are an extra argument it may ignore.
   */
  resolveToken(
    token: string,
    facts: McpRequestFacts,
  ): Promise<ResolvedToken | null> | ResolvedToken | null;
  /** Route path. Overridable so an app can mount a second, app-scoped surface. */
  readonly path?: string;
  /** Bytes this transport will hold for one request. Defaults to `DEFAULT_MCP_BODY_LIMIT_BYTES`. */
  readonly bodyLimitBytes?: number | undefined;
  /**
   * Requests per minute per caller, by class — defaults to `MCP_RATE_LIMITS` — and failed
   * authentications per minute per address (`unauthenticated`, `MCP_UNAUTHENTICATED_LIMIT`).
   */
  readonly rateLimits?: McpRateLimits | undefined;
  /**
   * Where the buckets are counted. Defaults to a per-PROCESS memory store, which is the honest
   * default for `x mcp serve` and a lie for N replicas behind one URL — each would enforce the
   * full allowance on its own. A fleet passes `postgresRateLimitStore({ executor })` from
   * `@ultimat3/http`, the same store the web role's limiter takes.
   */
  readonly rateLimitStore?: RateLimitStore | undefined;
  /** The one clock the buckets refill on. Defaulted, never read inline, so a test can freeze it. */
  readonly clock?: Clock | undefined;
  /**
   * Publish RFC 9728 protected-resource metadata and name it in every 401's `WWW-Authenticate` —
   * the discovery an OAuth-capable MCP client (a remote connector) starts from. Absent, the 401
   * says `Bearer realm="ultimate-mcp"` as it always did.
   */
  readonly oauth?: McpOAuth | undefined;
  /** `scopes_supported` when `oauth.scopesSupported` is not stated: the app's scope names. */
  readonly scopes?: readonly string[] | undefined;
}

/** How the host saw the request — what a bare `Request` behind a TLS-terminating proxy cannot say. */
export interface McpRequestOrigin {
  /**
   * The PUBLIC origin, `https://www.example.com`: the URLs this route publishes, and the self origin
   * a browser's `Origin` is proven against. Defaults to the request URL's own. Both are read off
   * the Host, so a DNS-rebound name proves same-origin: a server that serves only this machine
   * refuses a non-loopback Host before calling `handle` (`x mcp serve`, `mcpHostRefused`).
   */
  readonly origin?: string | undefined;
  /**
   * An EXACT allowance for a sibling origin — the app's `http.cors.origins`, through
   * `@ultimat3/http`'s `originListed`. Absent: the request's own origin only.
   */
  readonly listed?: ((origin: string) => boolean) | undefined;
  /**
   * The caller's address as the host resolved it (a trusted proxy's `x-forwarded-for` honoured) —
   * what failed authentications are counted against. Absent, they are not counted here: one
   * shared key would let a stranger's failures lock every agent out.
   */
  readonly address?: string | undefined;
}

/** The metadata half of an `oauth` route: where to serve it and what to answer. */
export interface McpProtectedResource {
  /** `/.well-known/oauth-protected-resource/mcp` and the root one. `GET`, public. */
  readonly paths: readonly string[];
  /** The document, for the public origin the request arrived on. */
  document(origin: string): Record<string, unknown>;
}

export interface McpRouteDescriptor {
  readonly method: 'POST';
  readonly path: string;
  /** Bucket for one already-parsed body. Metering only — never an authz decision. */
  rateLimitClass(body: unknown): McpVerbClass;
  /** Requests per minute per caller, by class — what `handle` actually spends against. */
  readonly limits: McpRateLimits;
  /** Present exactly when the route was built with `oauth`. */
  readonly protectedResource?: McpProtectedResource;
  handle(request: Request, seen?: McpRequestOrigin): Promise<Response>;
}

export function mcpHttpRoute(input: McpHttpTransportInput): McpRouteDescriptor {
  const { server } = input;
  // At CONSTRUCTION, beside the two buckets and for the same reason: `readWithinLimit` refuses a
  // non-finite cap, but it does so on the first request an agent makes and only after
  // `resolveToken` has run — a number that cannot be enforced must fail where an author can act on
  // it. Floor of 0 because `@ultimat3/http`'s `bodyLimitBytes` accepts 0, and these two must not
  // answer one question two ways.
  const bodyLimitBytes = finiteCount(
    'mcpHttpRoute',
    'bodyLimitBytes',
    input.bodyLimitBytes ?? DEFAULT_MCP_BODY_LIMIT_BYTES,
    0,
  );
  const limits: McpRateLimits = input.rateLimits ?? MCP_RATE_LIMITS;
  const clock = input.clock ?? systemClock;
  const store = input.rateLimitStore ?? memoryRateLimitStore();
  // Built once, at construction: `toBucket` refuses an unusable pair (`X_RATE_LIMIT_INVALID`), and
  // a number that cannot be enforced must fail where an author can act on it rather than on the
  // first request an agent makes.
  const readBucket = toBucket('mcpHttpRoute rateLimits.read', {
    limit: limits.read,
    windowMs: MCP_RATE_LIMIT_WINDOW_MS,
  });
  const writeBucket = toBucket('mcpHttpRoute rateLimits.write', {
    limit: limits.write,
    windowMs: MCP_RATE_LIMIT_WINDOW_MS,
  });

  // A COUNT of failures, screened where it is declared: `toBucket` alone would read `NaN` as a
  // bound only at its own check, and `??` never fires for one.
  const unauthenticated = finiteCount(
    'mcpHttpRoute',
    'rateLimits.unauthenticated',
    limits.unauthenticated ?? MCP_UNAUTHENTICATED_LIMIT,
    1,
  );
  const failureBucket = toBucket('mcpHttpRoute rateLimits.unauthenticated', {
    limit: unauthenticated,
    windowMs: MCP_RATE_LIMIT_WINDOW_MS,
  });
  const failures = failureMeter(store, failureBucket, clock);

  const path = input.path ?? '/mcp';
  const oauth = input.oauth;
  if (oauth !== undefined) assertMcpOAuth(oauth);
  const scopes = input.scopes ?? [];
  // What the 401 names in `scope="…"` — only on an `oauth` route, the one a client discovers from.
  const challengeScopes = oauth === undefined ? [] : supportedScopes(oauth, scopes);
  assertScopeTokens(challengeScopes);
  const resourceOf = (request: Request, seen: McpRequestOrigin | undefined): string | undefined =>
    oauth === undefined
      ? undefined
      : resourceUrl(oauth, seen?.origin ?? new URL(request.url).origin, path);

  return {
    method: 'POST',
    path,
    limits,
    rateLimitClass: (body) => server.classify(body),
    ...(oauth === undefined
      ? {}
      : {
          protectedResource: {
            paths: metadataPaths(path),
            document: (origin: string) =>
              protectedResourceMetadata(oauth, resourceUrl(oauth, origin, path), scopes),
          },
        }),

    async handle(request: Request, seen?: McpRequestOrigin): Promise<Response> {
      const address = seen?.address;
      // Built once per request: the resolver's second argument and every refusal's audit facts.
      // The address inside is the host's answer (`seen.address`), never a header read here.
      const facts = requestFacts({ headers: request.headers, url: request.url, address });
      const audit = server.audit;
      // A browser page that cannot be shown to be this app's is refused before the token is read,
      // so a token in its hands decides nothing — core's `proveSameOrigin`, the rule CSRF, the sync
      // upgrade and `/_x` answer to. A client process sends no `Origin` and is never asked.
      const foreign = originRefusal({
        origin: facts.origin,
        secFetchSite: request.headers.get('sec-fetch-site'),
        self: seen?.origin ?? new URL(request.url).origin,
        listed: seen?.listed ?? (() => false),
        path,
      });
      if (foreign !== undefined) {
        audit.authRefused('origin-refused', foreign.status, facts);
        return foreign;
      }
      // Every authentication answer lands BEFORE the body is read. Parsing first meant a caller
      // holding a rejected token still learned whether its JSON was well formed — `400 parse
      // error` for one payload and `401` for the next is exactly the oracle the 401 exists to
      // remove, and it costs nothing to close: the body is not an input to any of these.
      const resource = resourceOf(request, seen);
      const metadataUrl = resource === undefined ? undefined : metadataUrlFor(resource);
      // An address that has spent its failures is refused BEFORE the credential store is asked:
      // counting only after the fact turned a 401 into a 429 and still answered a valid guess.
      const exhausted = await failures.refusing(address);
      if (exhausted !== undefined) {
        audit.authRefused('throttled', exhausted.status, facts);
        return exhausted;
      }
      // A failure spends the address's allowance; the 429 wins when that one did not fit.
      const refuse = async (
        reason: 'missing-token' | 'rejected-token',
        challenge: string,
      ): Promise<Response> => {
        const throttledNow = await failures.spend(address);
        const response = throttledNow ?? unauthorized(challenge);
        audit.authRefused(
          throttledNow === undefined ? reason : 'throttled',
          response.status,
          facts,
        );
        return response;
      };
      const token = bearerToken(request);
      if (token === null) {
        return refuse('missing-token', bearerChallenge(metadataUrl, false, challengeScopes));
      }

      const resolved = await input.resolveToken(token, facts);
      if (resolved === null) {
        return refuse('rejected-token', bearerChallenge(metadataUrl, true, challengeScopes));
      }
      if (!isAgentActor(resolved.actor)) {
        audit.authRefused('not-an-agent', 403, facts);
        return notAnAgent();
      }

      // Read through the counting reader, never `request.json()`: the cap has to be enforced
      // WHILE the bytes arrive, or a `transfer-encoding: chunked` payload is materialised in full
      // before anything measures it. Core owns the reader so this and `UltimateRequest.#read`
      // cannot drift.
      const read = await readWithinLimit(request.body, bodyLimitBytes);
      if ('over' in read) {
        // Still the JSON-RPC envelope on `id: null` — a client library parses that and a consumer
        // has pinned it — and the stdio transport answers the same condition the same way. What
        // travels now is the refusal: the code, both numbers, and the two moves that end it,
        // built by the error that owns the wording so the two transports cannot drift.
        const refusal = new McpBodyTooLargeError({
          transport: 'http',
          limit: bodyLimitBytes,
          over: read.over,
        });
        return json(
          errorResponse(null, INVALID_REQUEST, refusalMessage(refusal), {
            code: refusal.code,
            cause: refusal.cause,
            fix: refusal.fix,
            docs: refusal.docs,
            limit: bodyLimitBytes,
          }),
          413,
        );
      }

      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(read.bytes));
      } catch {
        return json(errorResponse(null, PARSE_ERROR, 'request body is not valid JSON'), 400);
      }

      // A versioned request mirrors its body into headers, and an intermediary may have routed on
      // them: one that disagrees is refused before it is metered or run.
      const refusedHeaders = headerRefusal(body, request.headers);
      if (refusedHeaders !== undefined) return json(refusedHeaders, 400);

      // Metered AFTER the class is known and BEFORE the tool runs. It cannot move above the
      // parse — the class comes out of the body — and an unauthenticated caller never reaches it,
      // so a token nobody issued cannot spend an actor's allowance.
      const verbClass = server.classify(body);
      const bucket = verbClass === 'write' ? writeBucket : readBucket;
      const decision = await store.take(
        // `<route>|<subject>`, the shape `@ultimat3/http`'s own keys take, spelled here rather
        // than borrowed: that package's key builder answers "actor, else org, else the connection
        // address", a precedence with nothing to decide on this route — an unauthenticated caller
        // was answered 401 four lines up, so there is ALWAYS an actor and never an address. The
        // route half carries the CLASS because `read` and `write` are two allowances, and charging
        // both to one key would let a handshake burst close the writes behind it.
        `mcp:${verbClass}|actor:${resolved.actor.id}`,
        bucket,
        1,
        clock.now().getTime(),
      );
      if (!decision.allowed) {
        return throttled(verbClass, bucket.capacity, decision.retryAfterSeconds);
      }

      const caller: McpCaller = {
        actor: resolved.actor,
        scopes: resolved.scopes,
        ...(resolved.role !== undefined ? { role: resolved.role } : {}),
      };

      // The wire named, so a refusal that tells the client where to resend names THIS mount and
      // not a spelled `/mcp`.
      const response = await server.handle(body, caller, { transport: 'http', path });
      // A notification has no response. 202 with an empty body is the MCP-correct answer.
      if (response === null) return new Response(null, { status: 202, headers: NO_STORE_HEADERS });
      // JSON-RPC errors are 200s: the transport succeeded, the call did not. A malformed envelope,
      // an unserved version and a modern unknown method are the HTTP-level ones.
      return json(response, httpStatusOf(body, response));
    },
  };
}

/** `Authorization: Bearer <token>`, the only accepted form. No query-string tokens. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * A token-authenticated MCP caller is ALWAYS `kind: 'agent'`, never the human the token
 * belongs to. Enforced here rather than trusted from `resolveToken`, so a policy that says
 * "agents may not do this" cannot be bypassed by an app handing back a user actor.
 */
export function isAgentActor(actor: Actor): boolean {
  return (actor as { kind?: unknown }).kind === 'agent';
}
