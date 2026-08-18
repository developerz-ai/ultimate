/**
 * The fan-out, and the four things a hand-rolled `Promise.all` over `agent()` gets wrong: the
 * actor, the order, the difference between ran-and-failed and never-ran, and the ceiling.
 *
 * No test here asserts a DURATION. Out-of-order completion is forced with a gate one member opens
 * for another, and the escape that stops a broken pool from hanging the suite is a microtask pump,
 * never a timer — so the ordering fact is decided by the scheduler, not by a clock.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { action, isAction, resetRegistry } from '@ultimat3/action';
import { createContext, userActor } from '@ultimat3/core';
import { allow, deny } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import { createGateway } from './gateway';
import { hive } from './hive';
import { definePrompt, type Prompt } from './prompt';
import type { GenerateResult, Provider, TokenUsage } from './provider';
import { costOf, EchoProvider, messageText } from './provider';
import { configureAi, resetAiRuntime } from './runtime';

const USAGE: TokenUsage = {
  inputTokens: 12,
  outputTokens: 8,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/**
 * Keyed by the rendered prompt, never by call count: members run concurrently, so `seen.length`
 * would decide a reply by whichever worker happened to win the tick.
 */
function byPrompt(
  fail: (prompt: string) => boolean = () => false,
  /**
   * Microtasks the provider holds a call open for. The scheduler seam the budget case needs: a
   * reservation is only overlapping if the first member has not RECORDED before the others
   * reserve, and holding the socket open is exactly what a real call does.
   */
  hold = 0,
): {
  provider: Provider;
  seen: string[];
} {
  const seen: string[] = [];
  const provider: Provider = {
    name: 'keyed',
    async generate(request) {
      const prompt = request.messages.map(messageText).join(' ');
      seen.push(prompt);
      if (fail(prompt)) {
        // A 400 is never retried, so one refusal is one provider call — the test can count them.
        throw Object.assign(new Error('no'), { status: 400 });
      }
      if (hold > 0) await ticks(hold);
      return {
        model: 'claude-opus-5',
        text: '',
        toolCalls: [{ id: 'c1', name: 'respond', input: { echo: prompt } }],
        stopReason: 'tool_use',
        stopDetails: undefined,
        usage: USAGE,
        cost: costOf('claude-opus-5', USAGE),
      } satisfies GenerateResult;
    },
    models: ['claude-opus-5'],
    stream: (request) => new EchoProvider().stream(request),
  };
  return { provider, seen };
}

let seq = 0;
function promptFor(): Prompt<{ topic: string }> {
  seq += 1;
  return definePrompt<{ topic: string }>({
    id: `hive-${seq}`,
    version: '1.0.0',
    template: 'Work on {{topic}}.',
  });
}

/** A member that is an ordinary action — the deterministic half, with no model in it. */
function worker(log: string[], gate?: Promise<unknown>, open?: () => void) {
  return action({
    input: t.object({ id: t.string }),
    output: t.object({ id: t.string, actor: t.string }),
    policy: allow(),
    mcp: { expose: true },
    async handle({ input, ctx }) {
      if (input.id === 'slow' && gate !== undefined) await gate;
      if (input.id === 'fast' && open !== undefined) open();
      log.push(input.id);
      return { id: input.id, actor: ctx.actor.id };
    },
  }).named('workOne');
}

/** A member that is a real `agent()`, so the model path, the budget and the span are all live. */
function modelWorker(name: string) {
  return agent({
    input: t.object({ topic: t.string }),
    output: t.object({ echo: t.string }),
    prompt: promptFor(),
    vars: ({ input }) => ({ topic: input.topic }),
    tools: [],
    policy: allow(),
  }).named(name);
}

const ctxAs = (id: string) => createContext({ actor: userActor({ id }) });

/**
 * The scheduler seam. `ticks(n)` settles after n microtasks — so a pool that never runs the member
 * which opens the gate FAILS on the ordering assertion instead of hanging the suite, and nothing
 * in this file consults a clock.
 */
async function ticks(count: number): Promise<'timeout'> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
  return 'timeout';
}

beforeEach(() => {
  resetAiRuntime();
  resetRegistry();
});

describe('members come back in split order', () => {
  test('a member that settles last is still reported first, under out-of-order completion', async () => {
    const log: string[] = [];
    let open = (): void => {};
    const opened = new Promise<'opened'>((resolve) => {
      open = () => resolve('opened');
    });
    const member = worker(log, Promise.race([opened, ticks(200)]), open);

    const fanOut = hive({
      input: t.object({}),
      member,
      split: () => [{ id: 'slow' }, { id: 'fast' }],
      concurrency: 2,
      onMemberError: 'collect',
      policy: allow(),
    }).named('orderedHive');

    const result = await fanOut({}, { ctx: ctxAs('user-7') });
    // `fast` finished first...
    expect(log).toEqual(['fast', 'slow']);
    // ...and the answer is still in the order `split` produced them, with `index` to prove it.
    expect(result.members.map((one) => (one.status === 'ok' ? one.value.id : one.status))).toEqual([
      'slow',
      'fast',
    ]);
    expect(result.members.map((one) => one.index)).toEqual([0, 1]);
    expect(result.ok).toBe(2);
  });
});

describe('the actor boundary holds on the fan-out path', () => {
  test('every member runs as the request actor, and the split cannot name one', async () => {
    const log: string[] = [];
    const member = worker(log);
    const fanOut = hive({
      input: t.object({}),
      member,
      // The split invents an actor, exactly as a model output would. The member's own `input:`
      // drops it before any handler sees it, and `ctx.actor` was never derivable from it anyway.
      split: () =>
        [
          { id: 'a', actor: 'admin' },
          { id: 'b', actor: 'root' },
        ] as unknown as readonly { id: string }[],
      concurrency: 2,
      onMemberError: 'collect',
      policy: allow(),
    }).named('actorHive');

    const result = await fanOut({}, { ctx: ctxAs('user-7') });
    expect(result.members.every((one) => one.status === 'ok')).toBe(true);
    expect(result.members.map((one) => (one.status === 'ok' ? one.value.actor : 'x'))).toEqual([
      'user-7',
      'user-7',
    ]);
  });

  test("the hive's own policy still decides, before any member runs", async () => {
    const log: string[] = [];
    const fanOut = hive({
      input: t.object({}),
      member: worker(log),
      split: () => [{ id: 'a' }, { id: 'b' }],
      onMemberError: 'collect',
      policy: deny('no'),
    }).named('deniedHive');

    await expect(fanOut({}, { ctx: ctxAs('user-7') })).rejects.toMatchObject({
      code: 'X_FORBIDDEN',
    });
    expect(log).toEqual([]);
  });
});

describe('ran-and-failed is not never-ran', () => {
  test("onMemberError: 'abort' skips the siblings, and their provider is never called", async () => {
    const { provider, seen } = byPrompt((prompt) => prompt.includes('bad'));
    configureAi({ gateway: createGateway({ providers: [provider] }) });

    const fanOut = hive({
      input: t.object({}),
      member: modelWorker('summariseOne'),
      split: () => [{ topic: 'bad' }, { topic: 'a' }, { topic: 'b' }],
      // Serial on purpose: the point is that the siblings never START, which needs the failure to
      // land before they are dispatched.
      concurrency: 1,
      minMembers: 2,
      onMemberError: 'abort',
      policy: allow(),
    }).named('abortingHive');

    const result = await fanOut({}, { ctx: ctxAs('user-7') });
    expect(result.members.map((one) => one.status)).toEqual(['failed', 'skipped', 'skipped']);
    const first = result.members[0];
    expect(first?.status === 'failed' ? first.code : '').toBe('X_AI_PROVIDER_UNAVAILABLE');
    expect(result.ok).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(2);
    // The whole point: two members' worth of tokens were never bought.
    expect(seen).toHaveLength(1);
  });

  test("onMemberError: 'collect' harvests the rest", async () => {
    const { provider, seen } = byPrompt((prompt) => prompt.includes('bad'));
    configureAi({ gateway: createGateway({ providers: [provider] }) });

    const fanOut = hive({
      input: t.object({}),
      member: modelWorker('summariseTwo'),
      split: () => [{ topic: 'bad' }, { topic: 'a' }, { topic: 'b' }],
      concurrency: 1,
      onMemberError: 'collect',
      policy: allow(),
    }).named('collectingHive');

    const result = await fanOut({}, { ctx: ctxAs('user-7') });
    expect(result.members.map((one) => one.status)).toEqual(['failed', 'ok', 'ok']);
    expect(seen).toHaveLength(3);
  });
});

describe('the ceiling holds under concurrency', () => {
  // The property `budget.ts`'s root turnstile exists for, asserted through the hive rather than
  // asserted about the ledger: three members reserve before any of them records, so a ceiling only
  // one fits refuses the other two — no new budget machinery, and none needed.
  test('three members against a ceiling only one fits leaves exactly one ok', async () => {
    const { provider } = byPrompt(() => false, 200);
    configureAi({ gateway: createGateway({ providers: [provider] }) });

    const fanOut = hive({
      input: t.object({}),
      member: modelWorker('summariseThree'),
      split: () => [{ topic: 'a' }, { topic: 'b' }, { topic: 'c' }],
      concurrency: 3,
      // Enough for one member's pre-flight estimate, not for two overlapping ones.
      budget: { tokensPerRun: 4_200 },
      onMemberError: 'collect',
      policy: allow(),
    }).named('cappedHive');

    const result = await fanOut({}, { ctx: ctxAs('user-7') });
    expect(result.ok).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.members.filter((one) => one.status === 'failed').map((one) => one.code)).toEqual([
      'X_AI_BUDGET_EXCEEDED',
      'X_AI_BUDGET_EXCEEDED',
    ]);
    // The run's real spend, from the hive's own derived ledger — not zero, and not three members'.
    expect(result.tokens).toBeGreaterThan(0);
    expect(result.cost.currency).toBe('USD');
  });
});

describe('cancellation reaches the members', () => {
  test("a sibling's abort reaches an in-flight member's own ctx, and not the caller's", async () => {
    const seenAborted: boolean[] = [];
    let open = (): void => {};
    const opened = new Promise<'opened'>((resolve) => {
      open = () => resolve('opened');
    });
    const member = action({
      input: t.object({ id: t.string }),
      output: t.object({ id: t.string }),
      policy: allow(),
      mcp: { expose: true },
      async handle({ input, ctx }) {
        if (input.id === 'boom') {
          open();
          throw new Error('member exploded');
        }
        await Promise.race([opened, ticks(200)]);
        // Two more hops so the sibling's `catch` has run: this is the scheduler seam again.
        await ticks(20);
        seenAborted.push(ctx.signal.aborted);
        return { id: input.id };
      },
    }).named('watchOne');

    const caller = new AbortController();
    const fanOut = hive({
      input: t.object({}),
      member,
      split: () => [{ id: 'boom' }, { id: 'watch' }],
      concurrency: 2,
      onMemberError: 'abort',
      policy: allow(),
    }).named('linkedHive');

    const ctx = createContext({ actor: userActor({ id: 'user-7' }), signal: caller.signal });
    const result = await fanOut({}, { ctx });
    // The member saw ITS OWN aborted signal — a hive that ran members on the parent context
    // could not have told it anything.
    expect(seenAborted).toEqual([true]);
    // ...and the caller's signal is untouched: `onMemberError: 'abort'` is the hive stopping,
    // not the request being cancelled, so the partial harvest is still returned.
    expect(caller.signal.aborted).toBe(false);
    expect(result.members.map((one) => one.status)).toEqual(['failed', 'ok']);
  });

  test('an aborted caller unwinds the whole hive with X_ABORTED, never a partial answer', async () => {
    const log: string[] = [];
    const caller = new AbortController();
    const member = action({
      input: t.object({ id: t.string }),
      output: t.object({ id: t.string }),
      policy: allow(),
      mcp: { expose: true },
      handle({ input }) {
        log.push(input.id);
        caller.abort();
        return { id: input.id };
      },
    }).named('abortingOne');

    const fanOut = hive({
      input: t.object({}),
      member,
      split: () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      concurrency: 1,
      minMembers: 2,
      onMemberError: 'collect',
      policy: allow(),
    }).named('cancelledHive');

    const ctx = createContext({ actor: userActor({ id: 'user-7' }), signal: caller.signal });
    await expect(fanOut({}, { ctx })).rejects.toMatchObject({ code: 'X_ABORTED' });
    // Two members' work never bought, and no partial result handed back to nobody.
    expect(log).toEqual(['a']);
  });
});

describe('a hive that runs nothing says so', () => {
  test('an empty split is X_HIVE_EMPTY, never a successful run of zero members', async () => {
    const fanOut = hive({
      input: t.object({}),
      member: worker([]),
      split: () => [],
      onMemberError: 'collect',
      policy: allow(),
    }).named('emptyHive');

    await expect(fanOut({}, { ctx: ctxAs('user-7') })).rejects.toMatchObject({
      code: 'X_HIVE_EMPTY',
    });
  });
});

describe('a below-floor split is not fanned out, and loses nothing', () => {
  test('every input still runs when the split is under minMembers', async () => {
    const log: string[] = [];
    const fanOut = hive({
      input: t.object({}),
      member: worker(log),
      split: () => [{ id: 'only' }],
      minMembers: 4,
      concurrency: 8,
      onMemberError: 'collect',
      policy: allow(),
    }).named('floorHive');

    const result = await fanOut({}, { ctx: ctxAs('user-7') });
    expect(log).toEqual(['only']);
    expect(result.ok).toBe(1);
    expect(result.members).toHaveLength(1);
  });
});

describe('hive() is an action factory, not a ninth primitive', () => {
  test('it returns a real action and projects the member output through its own schema', () => {
    const fanOut = hive({
      input: t.object({}),
      member: worker([]),
      split: () => [{ id: 'a' }],
      onMemberError: 'collect',
      policy: allow(),
      mcp: { expose: true, description: 'Work on everything' },
    }).named('projectingHive');

    expect(isAction(fanOut)).toBe(true);
    expect(fanOut.describe().kind).toBe('action');
    expect(fanOut.tool().name).toBe('projectingHive');
    expect(fanOut.job().name).toBe('action:projectingHive');
    // The member's own `output` rides inside the `ok` arm — a hive publishes what it harvested,
    // not an opaque object.
    const schema = JSON.stringify(fanOut.describe().output);
    expect(schema).toContain('members');
    expect(schema).toContain('skipped');
    expect(schema).toContain('actor');
  });
});
