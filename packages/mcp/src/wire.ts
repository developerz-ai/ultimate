// JSON-RPC 2.0 vocabulary for the Ultimate MCP server: envelope types, the standard
// error codes, the advertised protocol version, and the two response constructors.
// Pure data + pure functions so every transport (http, stdio, a test) agrees on the wire
// without importing the server.
//
// Reference: https://modelcontextprotocol.io/specification (2025-06-18).

import { frameworkVersion } from '@ultimat3/core';

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
 * The JSON Schema subset the framework emits and `validate-args.ts` enforces. Narrow on
 * purpose: a tool schema an agent cannot fully understand is a tool it will call wrong.
 */
export interface JsonSchema {
  readonly type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null';
  readonly title?: string;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly const?: string | number | boolean | null;
  readonly default?: unknown;
  /**
   * NOT in the subset, and deliberately absent: `format` NAMES a rule whose meaning lives in
   * `@ultimat3/schema` (`uuid`, `email`, `iana-time-zone`, `bcp47-locale`), and this package
   * cannot enforce it without a second definition of each one — which would drift from the parse
   * the action itself runs and refuse values that surface accepts. So it is dropped by
   * `input-schema.ts` rather than published unchecked: an agent told `format: 'uuid'` by a server
   * that accepted `"not-a-uuid"` obeyed a rule nothing checked. `pattern` below is the opposite
   * case — the rule travels WITH the schema as a source string, so it is enforceable and is kept.
   *
   * `readonly format?: never;` states it in the type: a narrow() that starts copying `format`
   * again fails to compile rather than shipping a silent pass.
   */
  readonly format?: never;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  /**
   * A `RegExp.source` string, JSON Schema semantics (a partial match unless it anchors itself).
   * In the subset because `validate-args.ts` enforces it: without it `tools/list` published
   * `{minLength,maxLength}` for a field whose OpenAPI component carried the pattern, so an HTTP
   * client and an MCP agent held different contracts for one declaration and the agent's only
   * way to learn the format was `X_INPUT_INVALID` from the action's own parse.
   */
  readonly pattern?: string;
  readonly anyOf?: readonly JsonSchema[];
}

/** An empty-object schema — the honest shape for a no-argument tool. */
export const NO_ARGS: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };

export function resultResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

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
