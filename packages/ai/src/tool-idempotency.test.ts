// `idempotent: true` on an agent's tool: the reserved key argument is advertised to the model and
// reaches `invoke`, so a model retrying an ambiguous call replays the first result instead of
// buying the side effect twice. Parity with `@ultimat3/mcp` is `scripts/ai-mcp-tool-parity.test.ts`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  action,
  memoryIdempotencyStore,
  registerAction,
  resetActions,
  resetIdempotency,
  setIdempotencyStore,
} from '@ultimat3/action';
import { agentActor, ctxOf, runWithContext } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { refusal } from './bounds-fixture';
import { TOOL_IDEMPOTENCY_KEY_ARG, takeToolIdempotencyKey } from './tool-idempotency';
import { asProjectableAction, runLlmToolCall } from './tools';

const actor = agentActor({ id: 'agent-1' });
let runs = 0;

const charge = (idempotent: boolean) =>
  registerAction(
    'chargeCard',
    action({
      input: t.object({ amount: t.number }),
      output: t.object({ run: t.number }),
      policy: allow(),
      idempotent,
      mcp: { expose: true, description: 'Charge the card' },
      handle: () => {
        runs += 1;
        return { run: runs };
      },
    }),
  );

const call = (input: Record<string, unknown>) => ({ id: 'tu_1', name: 'chargeCard', input });

beforeEach(() => {
  runs = 0;
  setIdempotencyStore(memoryIdempotencyStore());
});

afterEach(() => {
  resetActions();
  resetIdempotency();
});

describe('an idempotent action as an agent tool', () => {
  test('advertises the optional, bounded key argument; a non-idempotent one does not', () => {
    const keyed = asProjectableAction(charge(true)).inputJsonSchema;
    expect(keyed?.properties?.[TOOL_IDEMPOTENCY_KEY_ARG]).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 255,
    });
    expect(keyed?.required ?? []).not.toContain(TOOL_IDEMPOTENCY_KEY_ARG);
    resetActions();
    const plain = asProjectableAction(charge(false)).inputJsonSchema;
    expect(plain?.properties).not.toHaveProperty(TOOL_IDEMPOTENCY_KEY_ARG);
  });

  test('a model retry with the same key replays the first result, the handler runs once', async () => {
    const tools = [asProjectableAction(charge(true))];
    const keyed = call({ amount: 5, [TOOL_IDEMPOTENCY_KEY_ARG]: 'retry-1' });
    const [first, second] = await runWithContext(ctxOf({}), async () => [
      await runLlmToolCall(tools, keyed, actor),
      await runLlmToolCall(tools, keyed, actor),
    ]);
    expect(first?.isError).toBeUndefined();
    expect(second?.content).toBe(first?.content);
    expect(runs).toBe(1);
  });

  test('an input that already names the argument is refused at projection, not merged', () => {
    const shadowing = registerAction(
      'shadowCard',
      action({
        input: t.object({ idempotencyKey: t.string }),
        output: t.object({ ok: t.boolean }),
        policy: allow(),
        idempotent: true,
        mcp: { expose: true },
        handle: () => ({ ok: true }),
      }),
    );
    expect(refusal(() => asProjectableAction(shadowing)).code).toBe(
      'X_MCP_IDEMPOTENCY_KEY_SHADOWED',
    );
  });

  test('the split never re-prototypes the input and treats a non-string key as none', () => {
    const args = JSON.parse('{"__proto__":{"polluted":true},"idempotencyKey":7,"amount":1}');
    const { input, idempotencyKey } = takeToolIdempotencyKey(args);
    expect(idempotencyKey).toBeNull();
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
    expect(input).toEqual(
      Object.fromEntries([
        ['__proto__', { polluted: true }],
        ['amount', 1],
      ]),
    );
  });
});
