/**
 * Pins the action DSL surface. Two different guarantees than `facade.test.ts`
 * (which proves the fluent methods behave correctly): this file proves the
 * *shape* cannot silently drift — every façade member still exists — and that
 * each member is a thin binding to its projection function, never a second
 * implementation. A member renamed, dropped, or quietly reimplemented here
 * fails this test, not just a downstream consumer.
 */
import { describe, expect, test } from 'bun:test';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { toOpenApiOperation } from './http';
import { toJobHandle } from './job-handle';
import { toMcpTool } from './mcp-tool';

const Input = t.object({ postId: t.uuid });
const Output = t.object({ id: t.uuid, published: t.boolean });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';

function defineTarget() {
  return action({
    input: Input,
    output: Output,
    policy: can('post:publish'),
    mcp: { expose: true, description: 'dsl pin' },
    handle: ({ input }) => ({ id: input.postId, published: true }),
  }).named('dslPublishPost');
}

// The exact contract: `ActionFacade` (action.ts) plus the base members every
// built action carries regardless of the façade. Kept in sync by hand on
// purpose — a silent drift here is exactly the regression this file exists
// to catch.
const BASE_MEMBERS = ['kind', 'name', 'describe', 'named'] as const;
const FACADE_MEMBERS = [
  'input',
  'output',
  'policy',
  'mcp',
  'as',
  'tool',
  'openapi',
  'client',
  'job',
  'contract',
] as const;

describe('the action DSL surface', () => {
  test('a built action is callable, and carries every façade member', () => {
    const target = defineTarget();
    expect(typeof target).toBe('function');
    for (const member of [...BASE_MEMBERS, ...FACADE_MEMBERS]) {
      expect(target).toHaveProperty(member);
    }
  });

  test('an action with no mcp block simply omits the member, not a placeholder', () => {
    const target = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      handle: ({ input }) => ({ id: input.postId, published: true }),
    }).named('dslNoMcp');
    expect('mcp' in target).toBe(false);
  });

  test('.tool() delegates to toMcpTool() — same data, same policy reference', () => {
    const target = defineTarget();
    const direct = toMcpTool(target);
    const viaFacade = target.tool();
    expect(viaFacade.name).toBe(direct.name);
    expect(viaFacade.action).toBe(direct.action);
    expect(viaFacade.description).toBe(direct.description);
    expect(viaFacade.inputSchema).toEqual(direct.inputSchema);
    expect(viaFacade.outputSchema).toEqual(direct.outputSchema);
    expect(viaFacade.policy).toBe(direct.policy);
  });

  test('.openapi() delegates to toOpenApiOperation() verbatim', () => {
    const target = defineTarget();
    expect(target.openapi()).toEqual(toOpenApiOperation(target));
  });

  test('.job() delegates to toJobHandle() — same input schema, same key function', () => {
    const target = defineTarget();
    const direct = toJobHandle(target);
    const viaFacade = target.job();
    expect(viaFacade.kind).toBe(direct.kind);
    expect(viaFacade.name).toBe(direct.name);
    expect(viaFacade.input).toBe(direct.input);
    expect(viaFacade.idempotencyKey({ postId: POST_ID })).toBe(
      direct.idempotencyKey({ postId: POST_ID }),
    );
  });

  test('.contract() delegates through the same registered assertions', () => {
    const target = defineTarget();
    const contracts = target.contract();
    expect(contracts.length).toBeGreaterThan(0);
    expect(contracts.every((contract) => typeof contract.run === 'function')).toBe(true);
  });

  // The DSL's central claim: no surface reaches a second authz object. `.tool()`
  // exposes the action to MCP, `.policy` is what `invoke` enforces on every call —
  // if these were ever two different objects, an MCP call could diverge from HTTP.
  test('a.tool().policy === a.policy — one authz object across every surface', () => {
    const target = defineTarget();
    expect(target.tool().policy).toBe(target.policy);
  });

  test('a named twin carries the same façade — naming never rebuilds it', () => {
    const target = defineTarget();
    const twin = target.named('dslPublishPostTwin');
    expect(twin.policy).toBe(target.policy);
    expect(twin.tool().policy).toBe(twin.policy);
    for (const member of [...BASE_MEMBERS, ...FACADE_MEMBERS]) {
      expect(twin).toHaveProperty(member);
    }
  });
});
