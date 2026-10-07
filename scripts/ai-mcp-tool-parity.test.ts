// The two action→tool adapters agree: `@ultimat3/ai`'s `asProjectableAction` (an in-app agent's
// tool) and `@ultimat3/mcp`'s `asProjectable` (an external agent's). Both are tier 4, so the tier
// table forces the copy — neither may import the other, tests included — and this host test is
// the one place both are reachable. An in-app agent and an external one must be offered exactly
// the same tool, so every field a model reads, and every way a call is decided, is asserted equal.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AnyAction } from '@ultimat3/action';
import {
  action,
  memoryIdempotencyStore,
  registerAction,
  resetActions,
  resetIdempotency,
  setIdempotencyStore,
} from '@ultimat3/action';
import { asProjectableAction } from '@ultimat3/ai';
import type { Actor } from '@ultimat3/core';
import {
  agentActor,
  ctxOf,
  isMcpExposed,
  isUltimateError,
  renderThrowable,
  runWithContext,
} from '@ultimat3/core';
import { asProjectable } from '@ultimat3/mcp';
import {
  can,
  clearPermissions,
  clearRoles,
  definePermissions,
  defineRoles,
} from '@ultimat3/policy';
import { t } from '@ultimat3/schema';

const owner = agentActor({ id: 'a1', orgId: 'o1', roles: ['owner'] });
const stranger = agentActor({ id: 'a2', orgId: 'o1', roles: [] });

let runs = 0;

const charge = (idempotent: boolean): AnyAction =>
  registerAction(
    'chargeCard',
    action({
      input: t.object({ amount: t.number, note: t.optional(t.string) }),
      output: t.object({ run: t.number }),
      policy: can('card:charge'),
      idempotent,
      mcp: { expose: true, description: 'Charge the card' },
      handle: () => {
        runs += 1;
        return { run: runs };
      },
    }),
  );

const inRequest = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(ctxOf({}), fn);

/** The coded refusal `run` made — the code is what a model reads first on either surface. */
async function codeOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (isUltimateError(error)) return error.code;
    return expect.unreachable(`expected a coded refusal, got ${renderThrowable(error)}`);
  }
  return expect.unreachable('the call was answered, not refused');
}

/** Both adapters over one action, each run the way its own surface runs it. */
function both(target: AnyAction) {
  const ai = asProjectableAction(target);
  const mcp = asProjectable(target);
  return {
    ai,
    mcp,
    runAi: (input: unknown, actor: Actor) => inRequest(() => ai.run({ input, actor })),
    runMcp: (input: unknown, actor: Actor) => inRequest(() => mcp.run({ input, actor })),
  };
}

beforeEach(() => {
  runs = 0;
  setIdempotencyStore(memoryIdempotencyStore());
  definePermissions(['card:charge']);
  defineRoles({ owner: { grants: ['card:charge'] } });
});

afterEach(() => {
  resetActions();
  resetIdempotency();
  clearPermissions();
  clearRoles();
});

describe('one action, one tool, whichever agent is offered it', () => {
  for (const idempotent of [false, true]) {
    test(`name, description, exposure and input schema agree (idempotent: ${idempotent})`, () => {
      const { ai, mcp } = both(charge(idempotent));
      expect(ai.name).toBe(mcp.name);
      expect(ai.description).toBe(mcp.description);
      expect(isMcpExposed(ai.mcp)).toBe(isMcpExposed(mcp.mcp));
      expect(ai.mcp?.description).toBe(mcp.mcp?.description);
      // The whole document a model is handed, the reserved key argument included — an idempotent
      // action an MCP client can retry safely is one an in-app agent can retry safely too.
      expect(ai.inputJsonSchema).toEqual(mcp.inputJsonSchema);
    });
  }

  test('the policy decides both, and a denied caller is refused with the same code', async () => {
    const { mcp, runAi, runMcp } = both(charge(false));
    const denied = await codeOf(() => runMcp({ amount: 1 }, stranger));
    expect(await codeOf(() => runAi({ amount: 1 }, stranger))).toBe(denied);
    // MCP's early gate (asked before argument validation) is the same decision, not a second one.
    expect(await codeOf(() => inRequest(async () => mcp.admit?.(stranger)))).toBe(denied);
    // Denied before the input is read, on both: a malformed call from a stranger learns nothing.
    expect(await codeOf(() => runAi({ amount: 'x' }, stranger))).toBe(denied);
    expect(runs).toBe(0);
  });

  test('the model cannot name its actor: an invented `actor` field is the input parse’s to drop', async () => {
    const { runAi, runMcp } = both(charge(false));
    const forged = { amount: 1, actor: 'admin' };
    expect(await codeOf(() => runAi(forged, stranger))).toBe(
      await codeOf(() => runMcp(forged, stranger)),
    );
  });

  test('an idempotent action: a retry with the same key replays on both, the handler runs once each', async () => {
    const { runAi, runMcp } = both(charge(true));
    const first = await runAi({ amount: 1, idempotencyKey: 'ai-k' }, owner);
    expect(await runAi({ amount: 1, idempotencyKey: 'ai-k' }, owner)).toEqual(first);
    const mcpFirst = await runMcp({ amount: 1, idempotencyKey: 'mcp-k' }, owner);
    expect(await runMcp({ amount: 1, idempotencyKey: 'mcp-k' }, owner)).toEqual(mcpFirst);
    expect(runs).toBe(2);
    // No key is an un-keyed run on both, exactly as HTTP without the header.
    await runAi({ amount: 1 }, owner);
    await runMcp({ amount: 1 }, owner);
    expect(runs).toBe(4);
  });

  test('a non-idempotent action never treats `idempotencyKey` as a key, on either', async () => {
    const { runAi, runMcp } = both(charge(false));
    const outcome = async (run: () => Promise<unknown>) => {
      const before = runs;
      const answer = await run().then(
        () => 'answered',
        (error: unknown) => (isUltimateError(error) ? error.code : renderThrowable(error)),
      );
      return { answer, ran: runs - before };
    };
    const keyed = { amount: 1, idempotencyKey: 'k' };
    const ai = [await outcome(() => runAi(keyed, owner)), await outcome(() => runAi(keyed, owner))];
    const mcp = [
      await outcome(() => runMcp(keyed, owner)),
      await outcome(() => runMcp(keyed, owner)),
    ];
    expect(ai).toEqual(mcp);
    // Whatever the input parse makes of the field, the second call is never a replay of the first.
    expect(ai[1]).toEqual(ai[0]);
  });

  test('an idempotent input that already names `idempotencyKey` is refused by both, the same way', () => {
    const shadowing = registerAction(
      'chargeCard',
      action({
        input: t.object({ idempotencyKey: t.string }),
        output: t.object({ ok: t.boolean }),
        policy: can('card:charge'),
        idempotent: true,
        mcp: { expose: true },
        handle: () => ({ ok: true }),
      }),
    );
    const refusal = (project: () => unknown) => {
      try {
        project();
      } catch (error) {
        if (isUltimateError(error)) return { code: error.code, cause: error.cause, fix: error.fix };
      }
      return expect.unreachable('a shadowing input was projected');
    };
    expect(refusal(() => asProjectableAction(shadowing))).toEqual(
      refusal(() => asProjectable(shadowing)),
    );
  });
});
