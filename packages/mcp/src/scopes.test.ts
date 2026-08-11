// `withScopes` — the declaration surface for OUTCOME 2. Everything here is about what happens
// at BOOT, because a scope entry that silently covers nothing ships a tool the author believes
// is gated and every connection can call.

import { describe, expect, test } from 'bun:test';
import type { AnyMcpTool } from './registry';
import { textResult } from './registry';
import { withScopes } from './scopes';

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false } as const;

const tool = (name: string, scope?: string): AnyMcpTool => ({
  name,
  description: name,
  inputSchema: NO_ARGS,
  ...(scope === undefined ? {} : { scope }),
  async handle() {
    return textResult('ran');
  },
});

const thrown = (
  fn: () => unknown,
): { code?: string; cause?: string; fix?: string; scopes?: readonly string[] } => {
  try {
    fn();
    return {};
  } catch (error) {
    return error as { code: string; cause: string; fix: string; scopes?: readonly string[] };
  }
};

const scopeOf = (tools: readonly AnyMcpTool[], name: string): string | undefined =>
  tools.find((candidate) => candidate.name === name)?.scope;

describe('withScopes', () => {
  test('attaches the declared scope to the named tool and leaves the rest ungated', () => {
    const catalog = [tool('refundOrder'), tool('orderById')];

    const scoped = withScopes(catalog, { 'orders:write': ['refundOrder'] });

    expect(scopeOf(scoped, 'refundOrder')).toBe('orders:write');
    // Absent, not `undefined`-valued: `exactOptionalPropertyTypes` and the wire both care.
    expect('scope' in (scoped.find((t) => t.name === 'orderById') ?? {})).toBe(false);
  });

  test('one scope covers many tools, and many scopes coexist', () => {
    const catalog = [tool('refundOrder'), tool('voidOrder'), tool('reindexCatalog')];

    const scoped = withScopes(catalog, {
      'orders:write': ['refundOrder', 'voidOrder'],
      'catalog:admin': ['reindexCatalog'],
    });

    expect(scoped.map((t) => t.scope)).toEqual(['orders:write', 'orders:write', 'catalog:admin']);
  });

  test('the tool keeps working — the scope is added, the handler is not replaced', async () => {
    const [scoped] = withScopes([tool('refundOrder')], { 'orders:write': ['refundOrder'] });

    expect(await scoped?.handle({}, { actor: { id: 'a' } as never, scopes: new Set() })).toEqual(
      textResult('ran'),
    );
  });

  test('no scopes declared returns the catalog untouched, same objects', () => {
    const catalog = [tool('refundOrder')];

    expect(withScopes(catalog, undefined)).toBe(catalog);
  });

  test('the input catalog is never mutated — the scope rides on a copy', () => {
    const catalog = [tool('refundOrder')];

    withScopes(catalog, { 'orders:write': ['refundOrder'] });

    expect(catalog[0]?.scope).toBeUndefined();
  });

  test('a name no projected tool answers to is X_MCP_SCOPE_UNKNOWN, not a silent no-op', () => {
    const catalog = [tool('refundOrder'), tool('orderById')];

    const error = thrown(() => withScopes(catalog, { 'orders:write': ['refundOrders'] }));

    expect(error.code).toBe('X_MCP_SCOPE_UNKNOWN');
    // The typo AND the catalog: the usual cause is a rename, so the fix has to be readable
    // without a second command.
    expect(error.cause).toContain('refundOrders');
    expect(error.cause).toContain('orderById, refundOrder');
    expect(error.fix).toContain('defineAppMcp');
  });

  test('an empty catalog says so rather than printing an empty list', () => {
    expect(thrown(() => withScopes([], { 'orders:write': ['refundOrder'] })).cause).toContain(
      'projected: nothing',
    );
  });

  test('one tool claimed by two scopes is X_MCP_SCOPE_CONFLICT — a tool carries one', () => {
    const catalog = [tool('refundOrder')];

    const error = thrown(() =>
      withScopes(catalog, { 'orders:write': ['refundOrder'], 'billing:admin': ['refundOrder'] }),
    );

    expect(error.code).toBe('X_MCP_SCOPE_CONFLICT');
    expect(error.cause).toContain('orders:write');
    expect(error.cause).toContain('billing:admin');
    // Structured, not only prose: the reader is an agent holding `--json`, and making it
    // re-parse the sentence to learn which two scopes collided is a field it should have had.
    expect(error.scopes).toEqual(['orders:write', 'billing:admin']);
  });

  test('a tool that already declares a scope is claimed too — two sources is the same ambiguity', () => {
    const catalog = [tool('dbQuery', 'db:read')];

    expect(thrown(() => withScopes(catalog, { 'db:admin': ['dbQuery'] })).code).toBe(
      'X_MCP_SCOPE_CONFLICT',
    );
  });

  test('re-declaring the SAME scope is not a conflict — it decides the same gate', () => {
    const catalog = [tool('dbQuery', 'db:read')];

    const scoped = withScopes(catalog, { 'db:read': ['dbQuery', 'dbQuery'] });

    expect(scopeOf(scoped, 'dbQuery')).toBe('db:read');
  });

  test('an empty scope entry is a no-op, not a refusal — declaring a capability early is fine', () => {
    const catalog = [tool('refundOrder')];

    expect(withScopes(catalog, { 'orders:write': [] })[0]?.scope).toBeUndefined();
  });
});
