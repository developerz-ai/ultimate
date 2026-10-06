// JSON-RPC 2.0 vocabulary for the Ultimate MCP server: envelope types, the standard
// error codes, the advertised protocol version, and the two response constructors.
// Pure data + pure functions so every transport (http, stdio, a test) agrees on the wire
// without importing the server.
//
// Reference: https://modelcontextprotocol.io/specification (2025-06-18).

import { frameworkVersion } from '@ultimat3/core';
import type { WireJsonSchema } from '@ultimat3/schema';

/** MCP protocol version advertised on `initialize`. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * Identity advertised on `initialize` unless the host overrides it. A call and not a constant:
 * `frameworkVersion()` resolves on first use, so importing this module cannot be what stops a
 * compiled single-file binary from booting.
 */
export function defaultServerInfo(): ServerInfo {
  return { name: 'ultimate', version: frameworkVersion() };
}

export interface ServerInfo {
  readonly name: string;
  readonly version: string;
}

export type JsonRpcId = string | number | null;

/** A request OR a notification — a notification is exactly "no `id`". */
export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: unknown;
  readonly id?: JsonRpcId;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

// ── standard error codes (jsonrpc.org/spec) ──────────────────────────────────
//
// The MCP spec adds no codes of its own, so the two security answers map onto these:
//   INVALID_REQUEST  (-32600) → Forbidden: the tool exists and you may see it, but your
//                               token lacks its scope.
//   METHOD_NOT_FOUND (-32601) → ToolNotFound: the tool is absent OR hidden from your role.
// Never the other way round — see `registry.ts`.

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/**
 * The JSON Schema subset a tool publishes and `validate-args.ts` enforces — `@ultimat3/schema`'s
 * `WireJsonSchema`, declared there so `@ultimat3/action`'s `.tool()` speaks the same one.
 */
export type JsonSchema = WireJsonSchema;

/** An empty-object schema — the honest shape for a no-argument tool. */
export const NO_ARGS: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };

export function resultResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/**
 * The `message` a coded refusal travels under: the cause AND the fix, in one sentence. `data`
 * carries both as fields; `message` is the ONE thing a client that reads nothing else prints, so a
 * consumer of `message` alone still gets the recovery step. Both transports build theirs here —
 * the HTTP 413 and the stdio over-long frame carry transport-specific wording, and this keeps the
 * SHAPE shared without forcing the text to be identical.
 */
export const refusalMessage = (refusal: { readonly cause: string; readonly fix: string }): string =>
  `${refusal.cause} — ${refusal.fix}`;

export function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  // exactOptionalPropertyTypes: attach `data` only when supplied.
  const error: JsonRpcError = { code, message, ...(data !== undefined ? { data } : {}) };
  return { jsonrpc: '2.0', id, error };
}

/** Minimal envelope check. A body failing this is `-32600`, never a crash. */
export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  return o['jsonrpc'] === '2.0' && typeof o['method'] === 'string';
}

/** A notification carries no `id`; the server answers nothing and the transport 202s. */
export function isNotification(req: JsonRpcRequest): boolean {
  return req.id === undefined;
}

/** `params` as a record, or `null` when the caller sent a non-object. */
export function paramsOf(req: JsonRpcRequest): Record<string, unknown> | null {
  if (typeof req.params !== 'object' || req.params === null) return null;
  return req.params as Record<string, unknown>;
}

/**
 * Which wire one message arrived on, so a refusal can name the unit THAT transport counts in.
 * `handle` is transport-independent and stays so — this is a hint for the wording of one fix, never
 * a branch in dispatch. HTTP carries its mounted path because `mcpHttpRoute({ path })` is a knob:
 * a batch refusal that told every client to retry `POST /mcp` was wrong for an app mounted at
 * `/app-mcp`, which is how this came to be threaded rather than spelled.
 */
export type McpWire =
  | { readonly transport: 'http'; readonly path: string }
  | { readonly transport: 'stdio' };

/** The unit a transport counts one request in — or the neutral word when no wire said. */
export const messageUnitOf = (wire: McpWire | undefined): string => {
  if (wire === undefined) return 'message';
  return wire.transport === 'http' ? `POST ${wire.path}` : 'line';
};
