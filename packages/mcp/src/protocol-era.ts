// Which protocol era one request speaks, and what each era answers: the `_meta` read, the methods
// per era and the rate-limit class of each, `initialize`'s negotiation, `server/discover`, the stamp
// every modern result carries, and the mirrored-header check HTTP owes a modern request. Split from
// `server.ts` so that file stays a dispatch. MCP 2026-07-28, `basic/versioning`.

import { McpHeaderMismatchError, McpProtocolUnsupportedError } from './errors-transport';
import { SPLIT_DISPATCHERS } from './meta-split';
import type { MetaSurface } from './meta-surface';
import { MANAGE_RESOURCE, META_TOOL_NAMES } from './meta-surface';
import type { McpVerbClass, ToolRegistry } from './registry';
import type { JsonRpcId, JsonRpcRequest, JsonRpcResponse, ServerInfo } from './wire';
import {
  errorResponse,
  HEADER_MISMATCH,
  INVALID_PARAMS,
  INVALID_REQUEST,
  isJsonRpcRequest,
  isNotification,
  MCP_LEGACY_VERSIONS,
  MCP_MODERN_VERSIONS,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
  METHOD_NOT_FOUND,
  paramsOf,
  refusalMessage,
  resultResponse,
  UNSUPPORTED_PROTOCOL_VERSION,
} from './wire';

/** Modern: stateless, versioned per request. Legacy: the `initialize` handshake. */
export type McpEra = 'modern' | 'legacy';

/** Every revision this server speaks: what `-32022` and `server/discover` both name. */
export const MCP_SUPPORTED_VERSIONS: readonly string[] = [
  ...MCP_MODERN_VERSIONS,
  ...MCP_LEGACY_VERSIONS,
];

const SHARED = [
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/read',
  'resources/templates/list',
  'prompts/list',
  'prompts/get',
] as const;

/** The methods each era answers. `METHODS` and `classifyBody` move with every new one. */
export const METHODS: Readonly<Record<McpEra, readonly string[]>> = {
  legacy: ['initialize', 'ping', ...SHARED],
  // `ping` and `initialize` do not exist in the modern revision; `server/discover` is mandatory.
  modern: ['server/discover', ...SHARED],
};

/** Each answer is one caller's, so nothing may be shared by an intermediary. */
const CACHEABLE = new Set([
  'server/discover',
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/read',
  'resources/templates/list',
]);

/** What `initialize` and `server/discover` advertise. Every `listChanged` is false: none is sent. */
export const CAPABILITIES = {
  tools: { listChanged: false },
  resources: { subscribe: false, listChanged: false },
  prompts: { listChanged: false },
} as const;

/** The `_meta` version a request names, or `undefined` for one that names none. */
export function requestedVersion(body: JsonRpcRequest): unknown {
  const meta = paramsOf(body)?.['_meta'];
  return isRecord(meta) ? meta[META_PROTOCOL_VERSION] : undefined;
}

/**
 * The era of one request. No `_meta` version: legacy, today's behaviour. A modern version: modern.
 * A legacy version in `_meta` is served as that legacy revision — `-32022` lists it as supported,
 * and a client retrying with it must not be refused again. Anything else: unsupported.
 */
export function eraOf(body: JsonRpcRequest): McpEra | { readonly unsupported: string | null } {
  const version = requestedVersion(body);
  if (version === undefined) return 'legacy';
  if (typeof version !== 'string') return { unsupported: null };
  if ((MCP_MODERN_VERSIONS as readonly string[]).includes(version)) return 'modern';
  if ((MCP_LEGACY_VERSIONS as readonly string[]).includes(version)) return 'legacy';
  return { unsupported: version };
}

/** `UnsupportedProtocolVersionError`: the spec's `{ supported, requested }`, plus our contract. */
export function unsupportedVersion(id: JsonRpcId, requested: string | null): JsonRpcResponse {
  const error = new McpProtocolUnsupportedError({ requested, supported: MCP_SUPPORTED_VERSIONS });
  return errorResponse(id, UNSUPPORTED_PROTOCOL_VERSION, refusalMessage(error), {
    supported: MCP_SUPPORTED_VERSIONS,
    requested,
    code: error.code,
    fix: error.fix,
    docs: error.docs,
  });
}

/** `initialize`: the client's revision echoed when served, else the newest legacy one. */
export function initializeResult(
  params: Record<string, unknown> | null,
  serverInfo: ServerInfo,
  instructions: string | undefined,
): Record<string, unknown> {
  const offered = params?.['protocolVersion'];
  const served = MCP_LEGACY_VERSIONS.find((version) => version === offered);
  return {
    protocolVersion: served ?? MCP_LEGACY_VERSIONS[0],
    capabilities: CAPABILITIES,
    serverInfo,
    ...(instructions === undefined ? {} : { instructions }),
  };
}

/** `server/discover`'s own fields; `stamped` adds `resultType`, `_meta` and the cache pair. */
export function discoverResult(instructions: string | undefined): Record<string, unknown> {
  return {
    supportedVersions: MCP_SUPPORTED_VERSIONS,
    capabilities: CAPABILITIES,
    ...(instructions === undefined ? {} : { instructions }),
  };
}

/** A modern result: `resultType`, `serverInfo` in `_meta`, and `ttlMs: 0` where the spec caches. */
export function stamped(
  response: JsonRpcResponse,
  method: string,
  serverInfo: ServerInfo,
): JsonRpcResponse {
  const result = response.result;
  if (!isRecord(result)) return response;
  const meta = isRecord(result['_meta']) ? result['_meta'] : {};
  return resultResponse(response.id, {
    ...result,
    resultType: 'complete',
    _meta: { ...meta, [META_SERVER_INFO]: serverInfo },
    ...(CACHEABLE.has(method) ? { ttlMs: 0, cacheScope: 'private' } : {}),
  });
}

/** Absent and hidden stay one answer per era: `-32602` modern, `-32601` legacy, never `data`. */
export const resourceNotFoundCode = (era: McpEra): number =>
  era === 'modern' ? INVALID_PARAMS : METHOD_NOT_FOUND;

/**
 * Rate-limit class of a body WITHOUT executing it, and WITHOUT a caller — bucket selection is
 * metering, not authorization. All MCP traffic is one `POST /mcp`, so a coarse per-route rule would
 * charge `initialize` and every read to the write bucket and throttle an agent on its handshake.
 * KEEP IN SYNC with `METHODS`: only `tools/call` can reach a tool, on either era.
 */
export function classifyBody(
  body: unknown,
  meta: MetaSurface | undefined,
  tools: ToolRegistry,
): McpVerbClass {
  if (!isJsonRpcRequest(body) || body.method !== 'tools/call') return 'read';
  const params = paramsOf(body);
  const name = params?.['name'];
  // An unresolvable call is refused before it runs, so charging it the strict bucket only costs a
  // broken client — it never hands an unproven verb the cheap one.
  if (typeof name !== 'string') return 'write';
  if (meta !== undefined && (name === MANAGE_RESOURCE || SPLIT_DISPATCHERS.includes(name))) {
    // Billed as the tool it reaches, so the dispatcher is never a cheap door to a write.
    const args = params?.['arguments'];
    const action = isRecord(args) ? args['action'] : undefined;
    return typeof action === 'string' ? tools.verbClass(action) : 'write';
  }
  if (meta !== undefined && META_TOOL_NAMES.includes(name)) return 'read';
  return tools.verbClass(name);
}

/** Methods whose `Mcp-Name` mirrors a body field, and the field. */
const NAMED: Readonly<Record<string, string>> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
};

/**
 * Over HTTP, a versioned request mirrors its body into headers; one absent or unequal is `-32020`.
 * Also the legacy header check: an `MCP-Protocol-Version` naming no served revision is `-32022`.
 * `undefined`: carry on. Notifications are exempt — the revision defines no header rule for them.
 */
export function headerRefusal(body: unknown, headers: Headers): JsonRpcResponse | undefined {
  if (!isJsonRpcRequest(body) || isNotification(body)) return undefined;
  const id = body.id ?? null;
  const header = headers.get('mcp-protocol-version');
  const version = requestedVersion(body);
  if (version === undefined) {
    if (header === null || (MCP_LEGACY_VERSIONS as readonly string[]).includes(header)) {
      return undefined;
    }
    // A modern version with no `_meta` is a body that disagrees with its header.
    if ((MCP_MODERN_VERSIONS as readonly string[]).includes(header)) {
      return mismatch(id, 'MCP-Protocol-Version', false);
    }
    return unsupportedVersion(id, header);
  }
  // A non-string `_meta` version is the dispatch's `-32022`, never a header question.
  if (typeof version !== 'string') return undefined;
  if (header !== version) return mismatch(id, 'MCP-Protocol-Version', header === null);
  if (eraOf(body) !== 'modern') return undefined;
  const method = headers.get('mcp-method');
  if (method !== body.method) return mismatch(id, 'Mcp-Method', method === null);
  const field = Object.hasOwn(NAMED, body.method) ? NAMED[body.method] : undefined;
  const expected = field === undefined ? undefined : paramsOf(body)?.[field];
  // A body missing its name is the dispatch's `-32602`; there is nothing to compare against.
  if (typeof expected !== 'string') return undefined;
  const name = headers.get('mcp-name');
  if (name === null) return mismatch(id, 'Mcp-Name', true);
  return decodeHeader(name) === expected ? undefined : mismatch(id, 'Mcp-Name', false);
}

const SENTINEL = /^=\?base64\?(.*)\?=$/;

/** `=?base64?…?=` decoded as UTF-8; the value itself otherwise; `undefined` for broken base64. */
export function decodeHeader(value: string): string | undefined {
  const encoded = SENTINEL.exec(value)?.[1];
  if (encoded === undefined) return value;
  try {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function mismatch(
  id: JsonRpcId,
  header: 'MCP-Protocol-Version' | 'Mcp-Method' | 'Mcp-Name',
  absent: boolean,
): JsonRpcResponse {
  const error = new McpHeaderMismatchError({ header, absent });
  return errorResponse(id, HEADER_MISMATCH, refusalMessage(error), {
    code: error.code,
    header,
    fix: error.fix,
    docs: error.docs,
  });
}

/**
 * The HTTP status of one answer: a refused envelope, a version or a header is 400; a method a
 * modern request names and this server does not answer is 404 (the spec's, so a dual-era client
 * can tell it from a legacy server's bare 404); every other JSON-RPC error is a 200.
 */
export function httpStatusOf(body: unknown, response: JsonRpcResponse): number {
  const code = response.error?.code;
  if (code === undefined) return 200;
  if (code === INVALID_REQUEST && response.id === null) return 400;
  if (code === UNSUPPORTED_PROTOCOL_VERSION || code === HEADER_MISMATCH) return 400;
  if (
    code === METHOD_NOT_FOUND &&
    isJsonRpcRequest(body) &&
    eraOf(body) === 'modern' &&
    !METHODS.modern.includes(body.method)
  ) {
    return 404;
  }
  return 200;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
