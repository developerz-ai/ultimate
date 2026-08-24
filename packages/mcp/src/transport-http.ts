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
import { readWithinLimit, systemClock } from '@ultimat3/core';
import type { RateLimitStore } from '@ultimat3/http';
import { memoryRateLimitStore, toBucket } from '@ultimat3/http';
import { McpRateLimitedError } from './errors';
import type { McpCaller, McpRole, McpVerbClass } from './registry';
import type { McpServer } from './server';
import type { JsonRpcResponse } from './wire';
import { errorResponse, INVALID_REQUEST, PARSE_ERROR } from './wire';

/**
 * The same 1 MiB `@ultimat3/http`'s `bodyLimitBytes` defaults to. This descriptor is driven from a
 * bare `Request` and never passes through that pipeline, so without a cap here Bun's 128 MiB
 * default was the only ceiling — and `x mcp serve` and `createServer` both pass no
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

/** What a token resolves to. `null` = unauthenticated, answered 401 with no catalog. */
export interface ResolvedToken {
  readonly actor: Actor;
  readonly scopes: ReadonlySet<string>;
  readonly role?: McpRole;
}

export interface McpHttpTransportInput {
  readonly server: McpServer;
  /**
   * Resolve an OAuth bearer / personal token to a caller. The framework supplies the token
   * string only — credential storage belongs to `@ultimat3/policy` and the app, never here.
   */
  resolveToken(token: string): Promise<ResolvedToken | null> | ResolvedToken | null;
  /** Route path. Overridable so an app can mount a second, app-scoped surface. */
  readonly path?: string;
  /** Bytes this transport will hold for one request. Defaults to `DEFAULT_MCP_BODY_LIMIT_BYTES`. */
  readonly bodyLimitBytes?: number | undefined;
  /** Requests per minute per caller, by class. Defaults to `MCP_RATE_LIMITS`. */
  readonly rateLimits?: Readonly<Record<McpVerbClass, number>> | undefined;
  /**
   * Where the buckets are counted. Defaults to a per-PROCESS memory store, which is the honest
   * default for `x mcp serve` and a lie for N replicas behind one URL — each would enforce the
   * full allowance on its own. A fleet passes `postgresRateLimitStore({ executor })` from
   * `@ultimat3/http`, the same store the web role's limiter takes.
   */
  readonly rateLimitStore?: RateLimitStore | undefined;
  /** The one clock the buckets refill on. Defaulted, never read inline, so a test can freeze it. */
  readonly clock?: Clock | undefined;
}

export interface McpRouteDescriptor {
  readonly method: 'POST';
  readonly path: string;
  /** Bucket for one already-parsed body. Metering only — never an authz decision. */
  rateLimitClass(body: unknown): McpVerbClass;
  /** Requests per minute per caller, by class — what `handle` actually spends against. */
  readonly limits: Readonly<Record<McpVerbClass, number>>;
  handle(request: Request): Promise<Response>;
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

export function mcpHttpRoute(input: McpHttpTransportInput): McpRouteDescriptor {
  const { server } = input;
  const bodyLimitBytes = input.bodyLimitBytes ?? DEFAULT_MCP_BODY_LIMIT_BYTES;
  const limits = input.rateLimits ?? MCP_RATE_LIMITS;
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

  return {
    method: 'POST',
    path: input.path ?? '/mcp',
    limits,
    rateLimitClass: (body) => server.classify(body),

    async handle(request: Request): Promise<Response> {
      // Every authentication answer lands BEFORE the body is read. Parsing first meant a caller
      // holding a rejected token still learned whether its JSON was well formed — `400 parse
      // error` for one payload and `401` for the next is exactly the oracle the 401 exists to
      // remove, and it costs nothing to close: the body is not an input to any of these.
      const token = bearerToken(request);
      if (token === null) return unauthorized();

      const resolved = await input.resolveToken(token);
      if (resolved === null) return unauthorized();
      if (!isAgentActor(resolved.actor)) return notAnAgent();

      // Read through the counting reader, never `request.json()`: the cap has to be enforced
      // WHILE the bytes arrive, or a `transfer-encoding: chunked` payload is materialised in full
      // before anything measures it. Core owns the reader so this and `UltimateRequest.#read`
      // cannot drift.
      const read = await readWithinLimit(request.body, bodyLimitBytes);
      if ('over' in read) {
        return json(
          errorResponse(
            null,
            INVALID_REQUEST,
            `request body is at least ${read.over} bytes, limit is ${bodyLimitBytes}`,
          ),
          413,
        );
      }

      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(read.bytes));
      } catch {
        return json(errorResponse(null, PARSE_ERROR, 'request body is not valid JSON'), 400);
      }

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

      const response = await server.handle(body, caller);
      // A notification has no response. 202 with an empty body is the MCP-correct answer.
      if (response === null) return new Response(null, { status: 202 });
      // JSON-RPC errors are 200s: the transport succeeded, the call did not. Only a
      // malformed envelope (below) is an HTTP-level failure.
      const status = response.error?.code === INVALID_REQUEST && response.id === null ? 400 : 200;
      return json(response, status);
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

/**
 * The refusal, rendered the way this file's 401 and 403 already are: `{ code, cause, fix }` and an
 * HTTP status, never a JSON-RPC envelope — the transport refused before dispatch, so there is no
 * call to answer. `retry-after` carries the same number the `fix:` line names, because an agent
 * reads one of the two and must not get different answers from them.
 */
function throttled(verbClass: McpVerbClass, limit: number, retryAfterSeconds: number): Response {
  const error = new McpRateLimitedError({ verbClass, limit, retryAfterSeconds });
  return new Response(JSON.stringify({ code: error.code, cause: error.cause, fix: error.fix }), {
    status: 429,
    headers: { ...JSON_HEADERS, 'retry-after': String(retryAfterSeconds) },
  });
}

function notAnAgent(): Response {
  return new Response(
    JSON.stringify({
      code: 'X_MCP_PROTOCOL',
      cause: 'resolveToken returned an actor whose kind is not "agent"',
      fix: 'return { kind: "agent", ... } from resolveToken; MCP callers are agents, not users',
    }),
    { status: 403, headers: JSON_HEADERS },
  );
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({
      code: 'X_MCP_PROTOCOL',
      cause: 'missing or unrecognised bearer token',
      fix: "send Authorization: Bearer <token> with a token the app's resolveToken(token) resolves to { actor, scopes } — it is the only issuer this route has",
    }),
    {
      status: 401,
      headers: { ...JSON_HEADERS, 'www-authenticate': 'Bearer realm="ultimate-mcp"' },
    },
  );
}

function json(response: JsonRpcResponse, status: number): Response {
  return new Response(JSON.stringify(response), { status, headers: JSON_HEADERS });
}
