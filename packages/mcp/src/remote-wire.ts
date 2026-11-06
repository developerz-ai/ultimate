// The bytes of one call to ANOTHER server's MCP endpoint: the headers each era owes, an answer that
// is JSON or an SSE stream (streamable HTTP lets a server pick either), and the JSON-RPC envelope
// read out of it. No state lives here — `remote-client.ts` holds the era and the session.

import { isJsonObject } from '@ultimat3/core';
import { META_PROTOCOL_VERSION } from './wire';

/** The answer body a streamable-HTTP server may send: a JSON-RPC response, or SSE carrying one. */
export function readRpcAnswer(
  contentType: string | null,
  text: string,
  id: number,
): Record<string, unknown> | undefined {
  if (contentType?.toLowerCase().startsWith('text/event-stream') === true) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      const parsed = parseJson(data);
      // A server may interleave its own requests and notifications; only OUR answer counts.
      if (isJsonObject(parsed) && parsed['id'] === id) return parsed;
    }
    return undefined;
  }
  const parsed = parseJson(text);
  return isJsonObject(parsed) ? parsed : undefined;
}

/** The `method` of every notification (no `id`) on an SSE answer; a JSON answer carries none. */
export function readNotifications(contentType: string | null, text: string): readonly string[] {
  if (contentType?.toLowerCase().startsWith('text/event-stream') !== true) return [];
  const methods: string[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    const parsed = parseJson(data);
    if (
      isJsonObject(parsed) &&
      parsed['id'] === undefined &&
      typeof parsed['method'] === 'string'
    ) {
      methods.push(parsed['method']);
    }
  }
  return methods;
}

/** RFC 9728 §5.1: `resource_metadata="<url>"` in a 401's `WWW-Authenticate`, when it is there. */
export function resourceMetadataOf(challenge: string | null): string | undefined {
  const match = /resource_metadata="([^"]+)"/i.exec(challenge ?? '');
  return match?.[1];
}

function parseJson(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not JSON is "no answer" — the caller names it as the server's refusal.
    return undefined;
  }
}

/** `Mcp-Name` must be a header value: printable ASCII verbatim, else the base64 sentinel. */
export function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value) && !value.startsWith('=?')) return value;
  const bytes = new TextEncoder().encode(value);
  return `=?base64?${btoa(String.fromCharCode(...bytes))}?=`;
}

/** Which body field a modern request mirrors into `Mcp-Name`. */
const NAMED: ReadonlyMap<string, string> = new Map([
  ['tools/call', 'name'],
  ['prompts/get', 'name'],
  ['resources/read', 'uri'],
]);

/** A modern request: `_meta` names the version, and the headers mirror the body. */
export function modernRequest(
  version: string,
  id: number,
  method: string,
  params: Record<string, unknown>,
): { readonly body: Record<string, unknown>; readonly headers: Record<string, string> } {
  const headers: Record<string, string> = {
    'mcp-protocol-version': version,
    'mcp-method': method,
  };
  const field = NAMED.get(method);
  const named = field === undefined ? undefined : field === 'uri' ? params['uri'] : params['name'];
  if (typeof named === 'string') headers['mcp-name'] = encodeHeader(named);
  const meta = isJsonObject(params['_meta']) ? params['_meta'] : {};
  return {
    body: {
      jsonrpc: '2.0',
      id,
      method,
      params: { ...params, _meta: { ...meta, [META_PROTOCOL_VERSION]: version } },
    },
    headers,
  };
}

/** The text a model reads from a `tools/call` result: text blocks joined, others named. */
export function resultText(result: Record<string, unknown>): string {
  const content = Array.isArray(result['content']) ? result['content'] : [];
  const parts = content.map((block: unknown) => {
    if (!isJsonObject(block)) return '';
    if (block['type'] === 'text' && typeof block['text'] === 'string') return block['text'];
    return `[${typeof block['type'] === 'string' ? block['type'] : 'unknown'} content]`;
  });
  if (parts.length === 0 && result['structuredContent'] !== undefined) {
    return JSON.stringify(result['structuredContent']);
  }
  return parts.join('\n');
}
