// An eval double is held to the tool's own input schema: a call production would refuse is refused
// in the eval with the same tool result, never scored as if the tool had answered.

import { afterEach, describe, expect, test } from 'bun:test';
import { action, resetActions } from '@ultimat3/action';
import { registerAction } from '@ultimat3/action/loader';
import { userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { scripted } from './eval-agent-fixture';
import { inProcessTool } from './in-process-tool';
import { useFixtureModels } from './model-fixture';
import { withEvalScope } from './runtime';
import type { AgentTool, LlmToolCall } from './tools';
import { asProjectableAction, runLlmToolCall } from './tools';

useFixtureModels();

afterEach(() => resetActions());

const actor = userActor({ id: 'ada' });
const Input = t.object({ id: t.string, notify: t.boolean.default(true) });

const viaAction = (): AgentTool => {
  const lookup = action({
    input: Input,
    output: t.object({ real: t.boolean }),
    policy: allow(),
    mcp: { expose: true },
    handle: () => ({ real: true }),
  });
  return registerAction('lookupOrder', lookup);
};

const viaInProcess = (): AgentTool =>
  inProcessTool({
    name: 'lookupOrder',
    description: 'Look one order up.',
    input: Input,
    execute: () => ({ real: true }),
  });

/** The call once in production and once inside an eval scope whose double records what it got. */
async function bothWays(tool: AgentTool, call: LlmToolCall) {
  const projected = [asProjectableAction(tool)];
  const production = await runLlmToolCall(projected, call, actor);
  const received: unknown[] = [];
  const scope = {
    eval: 'support',
    gateway: scripted().gateway,
    tools: {
      lookupOrder: (input: unknown) => {
        received.push(input);
        return { real: true };
      },
    },
    calls: [],
  };
  const evaluated = await withEvalScope(scope, () => runLlmToolCall(projected, call, actor));
  return { production, evaluated, received, calls: scope.calls };
}

describe('unit · an eval double is held to the tool input schema', () => {
  for (const [kind, tool] of [
    ['an action', viaAction],
    ['an in-process tool', viaInProcess],
  ] as const) {
    test(`${kind}: arguments production refuses are refused with the same tool result`, async () => {
      const call = { id: 'call-1', name: 'lookupOrder', input: { id: 5 } };
      const { production, evaluated, received, calls } = await bothWays(tool(), call);

      expect(production.isError).toBe(true);
      expect(evaluated).toEqual(production);
      expect(received).toEqual([]);
      expect(calls).toEqual([]);
    });

    test(`${kind}: the double gets the PARSED input, defaults applied`, async () => {
      const call = { id: 'call-1', name: 'lookupOrder', input: { id: 'o-1' } };
      const { evaluated, received } = await bothWays(tool(), call);

      expect(evaluated).toEqual({ toolUseId: 'call-1', content: '{"real":true}' });
      expect(received).toEqual([{ id: 'o-1', notify: true }]);
    });
  }
});

describe('unit · the reserved idempotency key is not part of the input', () => {
  test('an idempotent action: the key is taken off before the check, as `invoke` is handed it', async () => {
    // The framework's objects DROP an undeclared key, so a check that saw the key would pass anyway.
    // This one refuses it, as a strict schema an app brings would: the test fails unless the key
    // is taken off first.
    const standard = Input['~standard'];
    const strict: typeof Input = Object.assign(Object.create(Input), {
      '~standard': {
        ...standard,
        validate: (value: unknown) =>
          typeof value === 'object' && value !== null && Object.hasOwn(value, 'idempotencyKey')
            ? { issues: [{ message: 'idempotencyKey is not an input field' }] }
            : standard.validate(value),
      },
    });
    const keyed = action({
      input: strict,
      output: t.object({ real: t.boolean }),
      policy: allow(),
      mcp: { expose: true },
      idempotent: true,
      handle: () => ({ real: true }),
    });
    registerAction('lookupOrder', keyed);
    const call = {
      id: 'call-1',
      name: 'lookupOrder',
      input: { id: 'o-1', idempotencyKey: 'k-1' },
    };
    const received: unknown[] = [];
    const scope = {
      eval: 'support',
      gateway: scripted().gateway,
      tools: { lookupOrder: (input: unknown) => received.push(input) },
      calls: [],
    };

    const result = await withEvalScope(scope, () =>
      runLlmToolCall([asProjectableAction(keyed)], call, actor),
    );

    expect(result.isError).toBeUndefined();
    expect(received).toEqual([{ id: 'o-1', notify: true }]);
  });
});
