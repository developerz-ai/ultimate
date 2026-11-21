// `asProjectableAction` — the seam between a declared `action()` and the model's tool list.
// A file of its own so it runs beside `tools.test.ts` without pushing either past the ceiling.

import { describe, expect, test } from 'bun:test';
import { action } from '@ultimat3/action';
import { agentActor, ctxOf, runWithContext } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t, toWireSchema } from '@ultimat3/schema';
import type { ProjectableAction } from './tools';
import { asProjectableAction, runLlmToolCall, toolLabel } from './tools';

const actor = agentActor({ id: 'agent-1' });

const projectable = (
  name: string,
  mcp?: ProjectableAction['mcp'],
  run?: ProjectableAction['run'],
): ProjectableAction => ({
  name,
  ...(mcp === undefined ? {} : { mcp }),
  inputJsonSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  run: run ?? (async ({ input }) => ({ ran: name, input })),
});

describe('asProjectableAction', () => {
  const publishPost = () =>
    action({
      input: t.object({ id: t.string }),
      output: t.object({ published: t.boolean }),
      policy: allow(),
      mcp: { expose: true, description: 'Publish a draft post' },
      handle: ({ input, ctx }) => ({ published: `${input.id}:${ctx.actor.id}` !== '' }),
    });

  // One tool document per declaration: the model is offered what `.tool()` returns and what an MCP
  // client's `tools/list` serves, never a fuller draft-07 shape of its own.
  test('the model is offered the wire schema every other tool surface publishes', () => {
    const Input = t.object({ id: t.uuid, note: t.string.max(80) });
    const projected = asProjectableAction(
      action({
        input: Input,
        output: t.object({ ok: t.boolean }),
        policy: allow(),
        mcp: { expose: true },
        handle: () => ({ ok: true }),
      }).named('noteOn'),
    );
    expect(projected.inputJsonSchema).toEqual(toWireSchema(Input));
    // `true` is the schema package's projection, not a widening this surface added: an object root
    // ACCEPTS undeclared keys at the boundary and the action's parse drops them, so the AI surface
    // cannot drift away from the JSON one by publishing `false` here.
    // `inputJsonSchema` is optional on `ProjectableAction` (a hand-built tool may omit it), so the
    // reading below starts at the one document this projection always publishes.
    const schema =
      projected.inputJsonSchema ?? expect.unreachable('a projected action publishes its input');
    expect(schema.additionalProperties).toBe(true);
    expect(Object.keys(schema.properties as object)).toEqual(['id', 'note']);
    expect(schema.properties).toMatchObject({
      id: { type: 'string' },
      note: { type: 'string', maxLength: 80 },
    });
    expect(schema.required).toEqual(['id', 'note']);
  });

  test("a real action() becomes the seam, carrying its own schema and its declaration's name", () => {
    const projected = asProjectableAction(publishPost().named('publishPost'));
    expect(projected.name).toBe('publishPost');
    expect(projected.description).toBe('Publish a draft post');
    expect(projected.mcp?.expose).toBe(true);
    // The action's own `input:`, not the empty stand-in `toLlmTool` falls back to.
    expect(projected.inputJsonSchema).toMatchObject({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    });
  });

  test('run() is invoke: the action parses the model’s arguments and runs as the given actor', async () => {
    const seen: string[] = [];
    const probe = action({
      input: t.object({ id: t.string }),
      output: t.object({ id: t.string }),
      policy: allow(),
      mcp: { expose: true },
      handle: ({ input, ctx }) => {
        seen.push(`${ctx.actor.id}:${JSON.stringify(input)}`);
        return { id: input.id };
      },
    }).named('probe');

    await runWithContext(ctxOf({}), async () => {
      const result = await runLlmToolCall(
        [asProjectableAction(probe)],
        // The model names an actor and an extra field. Neither survives the action's own parse.
        { id: 'call-9', name: 'probe', input: { id: 'p1', actor: 'admin' } },
        actor,
      );
      expect(result).toEqual({ toolUseId: 'call-9', content: '{"id":"p1"}' });
    });
    expect(seen).toEqual(['agent-1:{"id":"p1"}']);
  });

  test('an unnamed action is refused rather than offered as a tool called ""', () => {
    expect(() => asProjectableAction(publishPost())).toThrow('X_ACTION_UNREGISTERED');
  });

  // Not itself since 30.0.0: a hand-built tool under a gated name waits like any other, so its `run`
  // is behind the gate (`tools-confirmation.test.ts`). The rest of it is what the author wrote.
  test('an already-projectable object keeps its fields, and projects to itself once projected', () => {
    const fake = projectable('handRolled', { expose: true });
    const once = asProjectableAction(fake);
    const { run: _fake, ...declared } = fake;
    const { run: _once, ...projected } = once;
    expect(projected).toEqual(declared);
    expect(asProjectableAction(once)).toBe(once);
  });

  test('toolLabel names an unregistered action instead of failing to name it', () => {
    expect(toolLabel(publishPost())).toBe('(an unregistered action)');
    expect(toolLabel(publishPost().named('publishPost'))).toBe('publishPost');
    expect(toolLabel(projectable('handRolled'))).toBe('handRolled');
  });
});
