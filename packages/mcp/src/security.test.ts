// The three-outcome security model as an executable contract.
//
// `docs/architecture/11-ai-surface.md` § Security posture is the spec; this file is what makes
// it enforced rather than documented. Every test here fails loudly if an outcome starts
// answering like another one — which is precisely how an enumeration oracle is born.

import { describe, expect, spyOn, test } from 'bun:test';
import { agentActor, UltimateError } from '@ultimat3/core';
import { McpScopeDeniedError } from './errors';
import type { AnyMcpTool, McpCaller } from './registry';
import { textResult } from './registry';
import { createMcpServer } from './server';
import type { JsonRpcResponse } from './wire';
import { INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND } from './wire';

const NO_ARGS_SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const;

function caller(role: string | undefined, scopes: readonly string[]): McpCaller {
  const actor = agentActor({ id: 'agent-1' });
  return role === undefined
    ? { actor, scopes: new Set(scopes) }
    : { actor, scopes: new Set(scopes), role };
}

/** A real denial, thrown the way `guard()` throws it: code, cause, runnable fix. */
class PolicyDeniedError extends UltimateError {
  constructor() {
    super({
      code: 'X_POLICY_DENIED',
      cause: 'refundOrder denied: actor lacks order:refund',
      fix: 'x policy explain refundOrder --json',
    });
  }
}

/** Read the wire the way an agent does: whatever is there, or nothing. */
const errorData = (response: JsonRpcResponse | null): Record<string, unknown> =>
  (response?.error?.data ?? {}) as Record<string, unknown>;

const toolResult = (response: JsonRpcResponse | null) =>
  (response?.result ?? {}) as { isError?: boolean; content?: { text: string }[] };

const listedNames = (response: JsonRpcResponse | null): readonly string[] =>
  ((response?.result as { tools?: { name: string }[] } | undefined)?.tools ?? []).map(
    (tool) => tool.name,
  );

const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});

const list = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list' };

describe('outcome 1 — hidden: absent from the catalog, ToolNotFound on call', () => {
  const hidden: AnyMcpTool = {
    name: 'org.destroy',
    description: 'owners only',
    inputSchema: NO_ARGS_SCHEMA,
    visibleTo: ['owner'],
    async handle() {
      return textResult('ran');
    },
  };
  const server = createMcpServer({ tools: [hidden] });

  test('a hidden tool answers exactly what a nonexistent one answers', async () => {
    const member = caller('member', ['every:scope']);
    const onHidden = await server.handle(call('org.destroy'), member);
    const onAbsent = await server.handle(call('no.such.tool'), member);

    // Same shape, same code, same message modulo the name: nothing in the answer says
    // which of the two it was. That equality IS the security property.
    expect(onHidden?.error?.code).toBe(METHOD_NOT_FOUND);
    expect(JSON.stringify(onHidden).replace('org.destroy', 'no.such.tool')).toBe(
      JSON.stringify(onAbsent),
    );
    // No `data` at all — any extra field is the difference a prober is looking for.
    expect(Object.keys(onHidden?.error ?? {}).sort()).toEqual(['code', 'message']);
  });

  test('holding every scope in the system does not reveal it', async () => {
    const response = await server.handle(
      call('org.destroy'),
      caller('member', ['owner', 'org:destroy', 'dev:read', 'db:migrate']),
    );
    expect(response?.error?.code).toBe(METHOD_NOT_FOUND);
    expect(JSON.stringify(response)).not.toContain('scope');
  });

  test('visibility is input-independent: different arguments, identical answer', async () => {
    const member = caller('member', []);
    const empty = await server.handle(call('org.destroy', {}), member);
    const probing = await server.handle(call('org.destroy', { orgId: 'o_9', force: true }), member);
    expect(JSON.stringify(probing)).toBe(JSON.stringify(empty));
  });

  test('visibility is fail-closed: a caller with no role sees nothing it named', async () => {
    const anonymous = caller(undefined, ['owner']);
    const listed = await server.handle(list, anonymous);
    expect(listedNames(listed)).toEqual([]);
    const response = await server.handle(call('org.destroy'), anonymous);
    expect(response?.error?.code).toBe(METHOD_NOT_FOUND);
  });

  test('a predicate audience is filtered per caller and never sees arguments', async () => {
    const seen: McpCaller[] = [];
    const perCaller: AnyMcpTool = {
      name: 'admin.seats',
      description: 'derived visibility',
      inputSchema: NO_ARGS_SCHEMA,
      visibleTo: (who) => {
        seen.push(who);
        return who.actor.id === 'agent-allowed';
      },
      async handle() {
        return textResult('seats');
      },
    };
    const scoped = createMcpServer({ tools: [perCaller] });
    const allowed: McpCaller = { actor: agentActor({ id: 'agent-allowed' }), scopes: new Set() };
    const refused: McpCaller = { actor: agentActor({ id: 'agent-other' }), scopes: new Set() };

    const forAllowed = await scoped.handle(list, allowed);
    const forRefused = await scoped.handle(list, refused);
    expect(listedNames(forAllowed)).toEqual(['admin.seats']);
    expect(listedNames(forRefused)).toEqual([]);

    // The predicate is handed the caller and nothing else — arguments are structurally out
    // of reach, so two calls with different inputs cannot decide visibility differently.
    expect(seen).toEqual([allowed, refused]);
    await scoped.handle(call('admin.seats', { orgId: 'o_1' }), refused);
    for (const who of seen) expect(Object.keys(who).sort()).toEqual(['actor', 'scopes']);
  });
});

describe('outcome 2 — scope: named out loud, and decided before the policy', () => {
  let handled = 0;
  const scoped: AnyMcpTool = {
    name: 'orders.refund',
    description: 'refund an order',
    inputSchema: {
      type: 'object',
      properties: { orderId: { type: 'string' } },
      required: ['orderId'],
      additionalProperties: false,
    },
    scope: 'orders:write',
    async handle() {
      handled += 1;
      throw new PolicyDeniedError();
    },
  };
  const server = createMcpServer({ tools: [scoped] });

  test('names the missing scope and carries a runnable fix', async () => {
    const response = await server.handle(
      call('orders.refund', { orderId: 'o_1' }),
      caller('member', []),
    );
    expect(response?.error?.code).toBe(INVALID_REQUEST);
    const data = errorData(response);
    expect(data['code']).toBe('X_MCP_SCOPE_DENIED');
    expect(data['scope']).toBe('orders:write');
    expect(data['fix']).toContain('x token grant orders:write');
    // Scope belongs to the connection, so the fix has to say the grant is not retroactive.
    expect(data['fix']).toContain('reconnect');
  });

  test('the refusal renders the contract three lines, with a registered title', () => {
    const denial = new McpScopeDeniedError({ name: 'orders.refund', scope: 'orders:write' });
    const lines = denial.format().split('\n');
    expect(lines).toHaveLength(3);
    // A humanised fallback title means the code was never registered — the agent then reads
    // a machine-shaped string where the contract promises a sentence.
    expect(lines[0]).toBe(
      "X_MCP_SCOPE_DENIED: the connection's token does not carry the tool's scope",
    );
    expect(lines[2]).toContain('x token grant orders:write');
  });

  test('the scope gate decides BEFORE the policy — the handler never runs', async () => {
    handled = 0;
    const response = await server.handle(
      call('orders.refund', { orderId: 'o_1' }),
      caller('member', []),
    );
    // The tool's policy would have denied too. A refusal that ran the policy first would be
    // a refusal decided from attacker-supplied input.
    expect(errorData(response)['code']).toBe('X_MCP_SCOPE_DENIED');
    expect(handled).toBe(0);
  });

  test('the scope gate decides BEFORE argument validation', async () => {
    const response = await server.handle(call('orders.refund', { nope: 1 }), caller('member', []));
    expect(response?.error?.code).toBe(INVALID_REQUEST);
    expect(errorData(response)['code']).toBe('X_MCP_SCOPE_DENIED');
  });

  test('with the scope, the call proceeds to the policy', async () => {
    handled = 0;
    const response = await server.handle(
      call('orders.refund', { orderId: 'o_1' }),
      caller('member', ['orders:write']),
    );
    expect(handled).toBe(1);
    expect(response?.error).toBeUndefined();
    expect(toolResult(response).isError).toBe(true);
  });

  test('bad arguments with the scope held are an argument error, not a scope one', async () => {
    const response = await server.handle(
      call('orders.refund', { nope: 1 }),
      caller('member', ['orders:write']),
    );
    expect(response?.error?.code).toBe(INVALID_PARAMS);
    expect(errorData(response)['code']).toBe('X_MCP_ARGS_INVALID');
  });
});

describe('outcome 3 — policy: X_POLICY_DENIED, exactly as HTTP answers it', () => {
  const guarded: AnyMcpTool = {
    name: 'orders.void',
    description: 'void an order',
    inputSchema: NO_ARGS_SCHEMA,
    async handle() {
      throw new PolicyDeniedError();
    },
  };
  const server = createMcpServer({ tools: [guarded] });

  test('renders as a tool result the model can reason about, not a transport failure', async () => {
    const response = await server.handle(call('orders.void'), caller('member', []));
    expect(response?.error).toBeUndefined();
    const result = toolResult(response);
    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('X_POLICY_DENIED');
    expect(text).toContain('cause:');
    expect(text).toContain('fix:   x policy explain refundOrder --json');
  });

  test('a denial is never downgraded to ToolNotFound or to a scope refusal', async () => {
    const response = await server.handle(call('orders.void'), caller('member', []));
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('X_MCP_TOOL_UNKNOWN');
    expect(serialized).not.toContain('X_MCP_SCOPE_DENIED');
    expect(response?.error?.code).not.toBe(METHOD_NOT_FOUND);
  });
});

describe('tools/list is per connection, not a static file', () => {
  const ownerOnly: AnyMcpTool = {
    name: 'org.billing',
    description: 'owners only',
    inputSchema: NO_ARGS_SCHEMA,
    visibleTo: ['owner'],
    async handle() {
      return textResult('ok');
    },
  };
  const open: AnyMcpTool = {
    name: 'org.profile',
    description: 'everyone',
    inputSchema: NO_ARGS_SCHEMA,
    async handle() {
      return textResult('ok');
    },
  };
  const server = createMcpServer({ tools: [ownerOnly, open] });

  test('one server object answers two callers with two catalogs', async () => {
    const asOwner = await server.handle(list, caller('owner', []));
    const asMember = await server.handle(list, caller('member', []));
    expect(listedNames(asOwner)).toEqual(['org.billing', 'org.profile']);
    expect(listedNames(asMember)).toEqual(['org.profile']);
  });

  test('a session that changes role gets the new catalog on the next list', async () => {
    const before = await server.handle(list, caller('member', []));
    const after = await server.handle(list, caller('owner', []));
    expect(JSON.stringify(before)).not.toBe(JSON.stringify(after));
  });
});

describe('every outcome is audited', () => {
  const hidden: AnyMcpTool = {
    name: 'org.destroy',
    description: 'owners only',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    visibleTo: ['owner'],
    async handle() {
      return textResult('ran');
    },
  };
  const server = createMcpServer({ tools: [hidden] });

  /** Reads the process logger's real output — the sink production uses, not a stand-in. */
  async function captureLines(run: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
    const lines: Record<string, unknown>[] = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim().length > 0) lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      return true;
    }) as never);
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return lines;
  }

  test('ToolNotFound is audited at warn — a name walk has to be detectable', async () => {
    const lines = await captureLines(() =>
      server.handle(call('org.destroy'), caller('member', [])),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'warn',
      msg: 'mcp.tool-call.hidden',
      surface: 'mcp',
      tool: 'org.destroy',
      outcome: 'hidden',
      actor: 'agent-1',
      role: 'member',
    });
  });

  test('the audit line carries the decision, never the data it was made about', async () => {
    const lines = await captureLines(() =>
      server.handle(
        call('org.destroy', { ssn: '000-00-0000', orgId: 'o_9' }),
        caller('member', []),
      ),
    );
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain('000-00-0000');
    expect(serialized).not.toContain('o_9');
  });

  test('a successful call is audited too, at info', async () => {
    const lines = await captureLines(() => server.handle(call('org.destroy'), caller('owner', [])));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', msg: 'mcp.tool-call.ok', outcome: 'ok' });
  });
});
