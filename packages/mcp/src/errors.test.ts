// The three error classes this package exports but no caller in the tree constructs —
// `McpToolUnknownError`, `McpArgsInvalidError` and `McpProtocolError`. They are public API
// (`index.ts` re-exports all three), so their cause and their fix are a contract even though
// the wire paths answer the same conditions with a JSON-RPC code instead.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, ERROR_DOCS_URL } from '@ultimat3/core';
import {
  MCP_ERROR_CODES,
  MCP_ERROR_TITLES,
  McpArgsInvalidError,
  McpBodyTooLargeError,
  McpProtocolError,
  McpToolUnknownError,
  TOOL_UNKNOWN_FIX,
} from './errors';

describe('the code table', () => {
  test('every code has a title and no title names a code the table does not declare', () => {
    expect(Object.keys(MCP_ERROR_TITLES).sort()).toEqual([...MCP_ERROR_CODES].sort());
  });

  // mcp passes no `docs:`, so the link is whatever the registry resolved: one page for every
  // code, declared once in `@ultimat3/core`. Pinned against the constant and never a literal — a
  // hand-copied URL is how the dead `https://ultimate.dev/errors/<code>` host survived every
  // suite in the tree, with the code interpolated into a fragment no page has an anchor for.
  test('every code resolves to the one docs page, never a per-code URL', () => {
    for (const code of MCP_ERROR_CODES) {
      expect(describeErrorCode(code).docs).toBe(ERROR_DOCS_URL);
      expect(describeErrorCode(code).docs).not.toContain(code);
    }
  });
});

describe('McpToolUnknownError', () => {
  test('names the visible catalog so the caller can see what it is allowed to call', () => {
    const error = new McpToolUnknownError({
      name: 'orders.void',
      visible: ['orders.read', 'orders.list'],
    });
    expect(error.code).toBe('X_MCP_TOOL_UNKNOWN');
    expect(error.cause).toBe(
      'no MCP tool named "orders.void" is visible to this caller (visible: orders.read, orders.list)',
    );
    expect(error.fix).toBe('call tools/list to read the catalog this caller may use');
    expect(error.docs).toBe(ERROR_DOCS_URL);
  });

  test('an empty catalog reads "none", never an empty parenthesis', () => {
    const error = new McpToolUnknownError({ name: 'orders.void', visible: [] });
    expect(error.cause).toContain('(visible: none)');
  });
});

describe('McpBodyTooLargeError', () => {
  test('over HTTP: the cause carries both numbers and the fix names the two knobs', () => {
    const error = new McpBodyTooLargeError({ transport: 'http', limit: 1024, over: 4096 });
    expect(error.code).toBe('X_MCP_BODY_TOO_LARGE');
    expect(error.cause).toBe('request body is at least 4096 bytes, limit is 1024');
    // A number, runnable as written: twice what arrived, because the cap itself would run and
    // change nothing, and `<n>` is not a TypeScript value.
    expect(error.fix).toContain('mcpHttpRoute({ bodyLimitBytes: 8192 })');
    expect(error.fix).toContain('defineAppMcp({ bodyLimitBytes: 8192 })');
    expect(error.fix).not.toContain('<n>');
    expect(error.limit).toBe(1024);
    expect(error.meta).toEqual({ transport: 'http', limit: 1024, over: 4096 });
  });

  test('over stdio: the fix names the line, the cap and the knob that raises it', () => {
    const error = new McpBodyTooLargeError({ transport: 'stdio', limit: 256 });
    expect(error.cause).toBe('one message exceeded 256 characters and was dropped');
    expect(error.fix).toContain('one JSON-RPC message per line');
    // Over stdio nothing measured what arrived — the tail was dropped — so twice the cap.
    expect(error.fix).toContain('serveStdio({ lineLimitBytes: 512 })');
    expect(error.fix).not.toContain('<n>');
    expect(error.meta).toEqual({ transport: 'stdio', limit: 256 });
  });
});

describe('the not-found hint', () => {
  test('is the one sentence McpToolUnknownError already gives, so the two cannot drift', () => {
    const error = new McpToolUnknownError({ name: 'x', visible: [] });
    expect(error.fix).toBe(TOOL_UNKNOWN_FIX);
  });
});

describe('McpArgsInvalidError', () => {
  test('carries every schema issue, joined, and points at the schema the agent was handed', () => {
    const error = new McpArgsInvalidError({
      name: 'publishPost',
      issues: ['postId: expected string', 'notify: expected boolean'],
    });
    expect(error.code).toBe('X_MCP_ARGS_INVALID');
    expect(error.cause).toBe(
      'arguments for "publishPost" are invalid: postId: expected string; notify: expected boolean',
    );
    expect(error.fix).toBe("re-read the tool's inputSchema from tools/list and resend");
  });
});

describe('McpProtocolError', () => {
  test('falls back to the envelope shape when the caller supplies no fix', () => {
    const error = new McpProtocolError({ cause: 'body is not an object' });
    expect(error.code).toBe('X_MCP_PROTOCOL');
    expect(error.cause).toBe('body is not an object');
    expect(error.fix).toBe("send a JSON-RPC 2.0 body: { jsonrpc: '2.0', id, method, params }");
    expect(error.docs).toBe(ERROR_DOCS_URL);
  });

  test('a supplied fix replaces the fallback rather than being appended to it', () => {
    const error = new McpProtocolError({
      cause: 'method not found: tools/invoke',
      fix: 'call tools/call, the method this server implements',
    });
    expect(error.fix).toBe('call tools/call, the method this server implements');
  });
});
