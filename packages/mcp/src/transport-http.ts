// `POST /mcp` — the HTTP transport.
//
// Exported as a route DESCRIPTOR rather than a mounted handler: `@ultimat3/http` owns the
// lifecycle (ALS context, tracing, rate limiting) and mounts this, while the descriptor
// stays drivable from a bare `Request` in a test. Two things travel with it that a generic
// route table cannot infer:
//
//  1. `rateLimitClass(body)` — all MCP traffic is one URL, so a per-route bucket would
//     charge `initialize` and every read to the write bucket and throttle an agent on its
//     handshake. The server classifies each body instead.
//  2. `authenticate` — a bearer token resolves to an Actor of kind 'agent'. An agent is
//     never silently upgraded to the user behind the token; policies see 'agent' and can
//     refuse what a human would be allowed.

import type { Actor } from '@ultimat3/core';
import { readWithinLimit } from '@ultimat3/core';
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

/** Requests per minute per token, by class. Reads are cheap; a write may run migrations. */
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
}

export interface McpRouteDescriptor {
  readonly method: 'POST';
  readonly path: string;
  /** Bucket for one already-parsed body. Metering only — never an authz decision. */
  rateLimitClass(body: unknown): McpVerbClass;
  readonly limits: Readonly<Record<McpVerbClass, number>>;
  handle(request: Request): Promise<Response>;
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

export function mcpHttpRoute(input: McpHttpTransportInput): McpRouteDescriptor {
  const { server } = input;
  const bodyLimitBytes = input.bodyLimitBytes ?? DEFAULT_MCP_BODY_LIMIT_BYTES;

  return {
    method: 'POST',
    path: input.path ?? '/mcp',
    limits: MCP_RATE_LIMITS,
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
