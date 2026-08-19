// A hand-written app tool has no second parse behind it — `invoke` re-parses for a projected
// action, and there is no `invoke` here. So `handle` received whatever `validate-args.ts` let
// through, typed `InferOutput<TInput>`: a tool declaring `t.uuid` was handed `"not-a-uuid"` as a
// validated uuid, past `guard()`, and the wire subset does not carry `format` to catch it either.
//
// Order matches `invoke`: parse, then policy, then the handler. One surface, one sequence.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { agentActor, createContext, isUltimateError, runWithContext } from '@ultimat3/core';
import { clearPermissions, clearRoles, definePermissions, defineRoles } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { AnyAppToolDefinition } from './app-tool';
import { appToolPrimitive } from './app-tool';
import { McpToolUnsafeError } from './errors';

const UUID = '3f0c3a2e-0a5f-4a1e-9d5b-0c9a0b1c2d3e';

const owner = agentActor({ id: 'agent-1', orgId: 'o1', roles: ['owner'] });
const stranger = agentActor({ id: 'agent-2', orgId: 'o1', roles: ['member'] });

let seen: unknown[] = [];

const definition = (overrides: Partial<AnyAppToolDefinition> = {}): AnyAppToolDefinition => ({
  description: 'archive one post',
  input: t.object({ postId: t.uuid, note: t.optional(t.string) }),
  policy: 'post:publish',
  handle: ({ input }) => {
    seen.push(input);
    return { ok: true };
  },
  ...overrides,
});

const run = (def: AnyAppToolDefinition, input: unknown, actor = owner): Promise<unknown> =>
  runWithContext(createContext({}), () =>
    appToolPrimitive('archivePost', def).run({ input, actor }),
  );

const codeOf = (error: unknown): string => (isUltimateError(error) ? error.code : 'not-an-error');

const thrownBy = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
};

beforeEach(() => {
  seen = [];
  definePermissions(['post:publish']);
  defineRoles({ owner: { grants: ['post:publish'] }, member: { grants: [] } });
});

afterEach(() => {
  clearPermissions();
  clearRoles();
});

describe('a hand-written tool parses its own input', () => {
  test('a value the declared schema rejects never reaches handle', async () => {
    const error = await thrownBy(run(definition(), { postId: 'not-a-uuid' }));
    expect(codeOf(error)).toBe('X_INPUT_INVALID');
    expect(seen).toEqual([]);
  });

  test('the refusal names the field, so an agent can resend', async () => {
    const error = await thrownBy(run(definition(), { postId: 'not-a-uuid' }));
    expect(String((error as { cause: string }).cause)).toContain('postId');
  });

  test('a missing required field is refused the same way', async () => {
    expect(codeOf(await thrownBy(run(definition(), {})))).toBe('X_INPUT_INVALID');
    expect(seen).toEqual([]);
  });

  test('handle receives the PARSED value, not the raw arguments', async () => {
    await run(definition(), { postId: UUID, extra: 'dropped-by-the-schema' });
    expect(seen).toEqual([{ postId: UUID }]);
  });

  test('a valid call still runs and returns the handler’s value', async () => {
    expect(await run(definition(), { postId: UUID })).toEqual({ ok: true });
  });
});

describe('the parse sits where invoke puts it — before the policy', () => {
  test('an invalid input under a denying policy is X_INPUT_INVALID, as an action would be', async () => {
    const error = await thrownBy(run(definition(), { postId: 'not-a-uuid' }, stranger));
    expect(codeOf(error)).toBe('X_INPUT_INVALID');
  });

  test('a valid input under a denying policy is still X_FORBIDDEN', async () => {
    const error = await thrownBy(run(definition(), { postId: UUID }, stranger));
    expect(codeOf(error)).toBe('X_FORBIDDEN');
    expect(seen).toEqual([]);
  });

  test('the policy sees the parsed input, the same object handle gets', async () => {
    const inputs: unknown[] = [];
    const def = definition({
      handle: ({ input, ctx }: { input: unknown; ctx: Ctx }) => {
        inputs.push(input);
        return { actor: ctx.actor?.id };
      },
    });
    expect(await run(def, { postId: UUID })).toEqual({ actor: 'agent-1' });
    expect(inputs).toEqual([{ postId: UUID }]);
  });
});

describe('boot-time refusals are unchanged', () => {
  test('a tool with no policy is refused before it can be served', () => {
    expect(() => appToolPrimitive('archivePost', definition({ policy: '' as 'a:b' }))).toThrow(
      McpToolUnsafeError,
    );
  });

  test('the published schema is the wire subset, not the rich one', () => {
    const primitive = appToolPrimitive('archivePost', definition());
    expect(primitive.inputJsonSchema?.properties?.['postId']?.type).toBe('string');
    expect(Object.hasOwn(primitive.inputJsonSchema?.properties?.['postId'] ?? {}, 'format')).toBe(
      false,
    );
  });
});
