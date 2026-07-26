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
import type { McpCaller, McpRole, McpVerbClass } from './registry.ts';
import type { McpServer } from './server.ts';
import type { JsonRpcResponse } from './wire.ts';
import { errorResponse, INVALID_REQUEST, PARSE_ERROR } from './wire.ts';

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

  return {
    method: 'POST',
    path: input.path ?? '/mcp',
    limits: MCP_RATE_LIMITS,
    rateLimitClass: (body) => server.classify(body),

    async handle(request: Request): Promise<Response> {
      const token = bearerToken(request);
      if (token === null) {
        // 401 before parsing: an unauthenticated caller learns nothing about the catalog,
        // not even whether its JSON was well formed.
        return unauthorized();
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json(errorResponse(null, PARSE_ERROR, 'request body is not valid JSON'), 400);
      }

      const resolved = await input.resolveToken(token);
      if (resolved === null) return unauthorized();
      if (!isAgentActor(resolved.actor)) return notAnAgent();

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
      fix: 'x token create --scopes dev:read, then send Authorization: Bearer <token>',
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
