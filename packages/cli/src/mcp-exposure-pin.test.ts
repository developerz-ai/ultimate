// One declaration, six readers, one answer: the pin that makes "one predicate" checkable.
// `mcp: { expose }` is read across `action`, `query`, `mcp` and `ai` — three tiers that cannot
// import each other, so no one of them can prove the others agree. `@ultimat3/cli` is tier 5 and
// may import all of them, which is why the pin lives here, like `schema-error-codes-pin.test.ts`.

import { describe, expect, test } from 'bun:test';
import { action, describeAction, toMcpTools, toOpenApiOperation } from '@ultimat3/action';
import { toLlmTools } from '@ultimat3/ai';
import { isMcpExposed } from '@ultimat3/core';
import { asProjectable, isExposed as isMcpToolExposed, toolsFrom } from '@ultimat3/mcp';
import { can } from '@ultimat3/policy';
import { from, query, toQueryTools } from '@ultimat3/query';
import { t } from '@ultimat3/schema';

const Input = t.object({ id: t.uuid });
const Output = t.object({ ok: t.boolean });

/** Every declaration an author can write, including the one they can only write by silence. */
const DECLARATIONS = [
  { label: 'no mcp block', mcp: undefined, exposed: false },
  { label: 'expose: false', mcp: { expose: false }, exposed: false },
  { label: 'expose: true', mcp: { expose: true }, exposed: true },
] as const;

const actionDeclaring = (mcp?: { readonly expose: boolean }) =>
  action({
    input: Input,
    output: Output,
    policy: can('post:publish'),
    ...(mcp === undefined ? {} : { mcp }),
    handle: () => ({ ok: true }),
  }).named('publishPost');

const queryDeclaring = (mcp?: { readonly expose: boolean }) =>
  query({
    input: Input,
    policy: can('feed:read'),
    ...(mcp === undefined ? {} : { mcp }),
    sql: ({ id }) => from<{ id: string }>('posts', [{ id }]).where({ id }).orderBy('id'),
  }).named('orgFeed');

// Lowercase on purpose — `bun test -t 'mcp expos'` is a substring match against the full test
// name, and a capitalized "MCP" would not have matched. Same lesson as `n-plus-one-detector.test.ts`'s
// `n1` describe prefix: pick the describe text so the command an author would actually type works.
describe('one predicate decides mcp exposure', () => {
  for (const { label, mcp, exposed } of DECLARATIONS) {
    test(`an action declaring ${label} is exposed=${exposed} on every surface`, () => {
      const target = actionDeclaring(mcp);
      expect(isMcpExposed(mcp)).toBe(exposed);

      // @ultimat3/action — the tool, the manifest fact, the OpenAPI operation.
      expect(toMcpTools([target]).length > 0).toBe(exposed);
      expect(describeAction(target).mcp.expose).toBe(exposed);
      expect(toOpenApiOperation(target)['x-ultimate']['mcpTool'] !== null).toBe(exposed);

      // @ultimat3/mcp — the projection an app's own MCP surface serves.
      const primitive = asProjectable(target);
      expect(isMcpToolExposed(primitive)).toBe(exposed);
      expect(toolsFrom([primitive]).length > 0).toBe(exposed);

      // @ultimat3/ai — the same catalog in the Anthropic tool wire format.
      expect(
        toLlmTools([
          { name: 'publishPost', ...(mcp === undefined ? {} : { mcp }), run: primitive.run },
        ]).length > 0,
      ).toBe(exposed);
    });

    test(`a query declaring ${label} is exposed=${exposed} on every surface`, () => {
      const target = queryDeclaring(mcp);
      expect(toQueryTools([target]).length > 0).toBe(exposed);
      const primitive = asProjectable(target);
      expect(isMcpToolExposed(primitive)).toBe(exposed);
      expect(toolsFrom([primitive]).length > 0).toBe(exposed);
    });
  }

  test('an action and a query saying the same thing get the same answer', () => {
    for (const { mcp, exposed } of DECLARATIONS) {
      expect(toMcpTools([actionDeclaring(mcp)]).length > 0).toBe(exposed);
      expect(toQueryTools([queryDeclaring(mcp)]).length > 0).toBe(exposed);
    }
  });
});
