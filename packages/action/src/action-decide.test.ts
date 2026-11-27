// `decide(rows)` is the action's own policy asked per row, on the call's own surface, through the
// one execution path. Adversarial on purpose: a denied row must never reach `allowed`, a policy
// that throws or answers garbage must never allow, and a handler must have no way to swap the rule.

import { afterEach, describe, expect, test } from 'bun:test';
import type { PolicyDecisionEvent } from '@ultimat3/core';
import { ctxOf, resetInstrumentation, subscribe, userActor } from '@ultimat3/core';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import type { Policy } from '@ultimat3/policy';
import { allow, can, denied, PolicyError } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import type { ActionDecision } from './action-decide';
import { toRoute } from './http';
import { invoke } from './invoke';
import type { Surface } from './policy-gate';

interface Post {
  readonly id: string;
  readonly authorId: string;
}

const POSTS: readonly Post[] = [
  { id: 'p1', authorId: 'ada' },
  { id: 'p2', authorId: 'bob' },
  { id: 'p3', authorId: 'ada' },
];

const Input = t.object({ ids: t.array(t.string) });
const Output = t.object({
  allowed: t.array(t.string),
  denied: t.array(t.object({ id: t.string, code: t.string, reason: t.string })),
});

// A batch action's rule answers two questions: with `row: null` the CALL (may this actor edit
// posts at all — the call's own guard asks it, no loader declared), and per row the ROW.
const ownPost = can<unknown, Post>('post:edit', ({ actor, row }) =>
  row === null || row.authorId === actor?.id ? true : denied('not the author', 'X_NOT_AUTHOR'),
);

const answer = (decision: ActionDecision<Post>) => ({
  allowed: decision.allowed.map((post) => post.id),
  denied: decision.denied.map(({ row, code, reason }) => ({ id: row.id, code, reason })),
});

const pick = (ids: readonly string[]): Post[] => POSTS.filter((post) => ids.includes(post.id));

const bulkEdit = (policy: Policy<unknown, Post> = ownPost) =>
  action({
    input: Input,
    output: Output,
    policy,
    handle: ({ input, decide }) => answer(decide(pick(input.ids))),
  }).named('bulkEditPosts');

const ada = () => ctxOf({ actor: userActor({ id: 'ada', permissions: ['post:edit'] }) });

const recordDecisions = (): PolicyDecisionEvent[] => {
  const events: PolicyDecisionEvent[] = [];
  subscribe('policy.decision', (event) => void events.push(event.payload));
  return events;
};

afterEach(() => resetInstrumentation());

describe('decide(rows)', () => {
  test('mixed rows split by the action’s own policy, in order, with code and reason', async () => {
    const out = await invoke(bulkEdit(), { ids: ['p1', 'p2', 'p3'] }, { ctx: ada() });
    expect(out).toEqual({
      allowed: ['p1', 'p3'],
      denied: [{ id: 'p2', code: 'X_NOT_AUTHOR', reason: 'not the author' }],
    });
  });

  // Every surface reaches `handle` through `invoke`, so every one gets the same decide; the row
  // decisions name the policy surface the call's own decision did (`PRIMITIVE_POLICY_SURFACES`).
  test.each([
    ['server', 'job'],
    ['job', 'job'],
    ['mcp', 'mcp'],
    ['http', 'http'],
  ] as const)('surface %s: one decision event per row, judged as %s', async (surface, judged) => {
    const events = recordDecisions();
    await invoke(bulkEdit(), { ids: ['p1', 'p2'] }, { ctx: ada(), surface: surface as Surface });
    // The call's two gates (actor half, then input + row) come first; then one per row.
    const rows = events.slice(-2);
    expect(rows.map((event) => [event.allowed, event.code, event.surface])).toEqual([
      [true, null, judged],
      [false, 'X_NOT_AUTHOR', judged],
    ]);
  });

  test('the HTTP projection hands the handler the same decide', async () => {
    const route = toRoute(bulkEdit());
    const app = httpServer({
      routes: [route],
      config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
      hooks: { authenticate: () => userActor({ id: 'ada', permissions: ['post:edit'] }) },
    });
    const response = await app.fetch(
      new Request(`http://dev.test${route.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://dev.test' },
        body: JSON.stringify({ ids: ['p1', 'p2'] }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ allowed: ['p1'] });
  });

  test('another policy cannot be named — not in the type, not at runtime', async () => {
    const sneaky = action({
      input: Input,
      output: Output,
      policy: ownPost,
      handle: ({ input, decide }) => {
        // @ts-expect-error decide takes rows alone: there is no slot for a second rule.
        const decision: ActionDecision<Post> = decide(pick(input.ids), allow());
        return answer(decision);
      },
    }).named('sneakyBulkEdit');
    const out = await invoke(sneaky, { ids: ['p2'] }, { ctx: ada() });
    expect(out).toMatchObject({ allowed: [], denied: [{ id: 'p2', code: 'X_NOT_AUTHOR' }] });
  });

  test('rows are typed by the policy: a row of another shape does not compile', () => {
    action({
      input: Input,
      output: Output,
      policy: ownPost,
      handle: ({ decide }) => {
        // @ts-expect-error `{ nope: 1 }` is not a Post.
        decide([{ nope: 1 }]);
        return { allowed: [], denied: [] };
      },
    });
  });

  test('absent before the input stage: the row loader is handed no decide', async () => {
    let seen: readonly string[] = [];
    const loaded = action({
      input: Input,
      output: Output,
      policy: ownPost,
      row: (args) => {
        // @ts-expect-error `ActionRowArgs` carries no decide.
        void args.decide;
        seen = Object.keys(args);
        return POSTS[0] ?? null;
      },
      handle: () => ({ allowed: [], denied: [] }),
    }).named('loadedBulkEdit');
    await invoke(loaded, { ids: [] }, { ctx: ada() });
    expect(seen).not.toContain('decide');
  });

  test('a predicate that throws fails the call — no row is answered allowed', async () => {
    const throwing = can<unknown, Post>('post:edit', ({ row }) => {
      if (row?.id === 'p3')
        throw new PolicyError({ code: 'X_FORBIDDEN', cause: 'predicate threw', fix: 'none' });
      return true;
    });
    let answered: ActionDecision<Post> | undefined;
    const probe = action({
      input: Input,
      output: Output,
      policy: throwing,
      handle: ({ input, decide }) => {
        answered = decide(pick(input.ids));
        return answer(answered);
      },
    }).named('throwingBulkEdit');
    await expect(invoke(probe, { ids: ['p1', 'p3'] }, { ctx: ada() })).rejects.toThrow(
      'predicate threw',
    );
    expect(answered).toBeUndefined();
  });

  // The rule above admits `row: null` — that is the call-level question. A missing row handed to
  // decide (a lookup that found nothing) must never borrow that answer.
  test('a null or undefined row is denied without asking the policy', async () => {
    let events: PolicyDecisionEvent[] = [];
    const lookup = action({
      input: Input,
      output: t.object({ allowed: t.number.int(), denied: t.array(t.string) }),
      policy: ownPost,
      handle: ({ input, decide }) => {
        const byId = new Map(POSTS.map((post) => [post.id, post]));
        const found = input.ids.map((id) => byId.get(id)) as Post[];
        events = recordDecisions();
        const decision = decide([...found, null as unknown as Post]);
        return {
          allowed: decision.allowed.length,
          denied: decision.denied.map((each) => each.code),
        };
      },
    }).named('lookupBulkEdit');
    const out = await invoke(lookup, { ids: ['p1', 'missing'] }, { ctx: ada() });
    expect(out).toEqual({ allowed: 1, denied: ['X_FORBIDDEN', 'X_FORBIDDEN'] });
    // p1 alone was asked: the missing rows were never evaluated as `null`.
    expect(events).toHaveLength(1);
  });

  // A hand-built policy is the one shape `isDecision` cannot vet: its `run` IS the decision.
  test('a decision whose allowed is truthy but not true denies the row', async () => {
    const lax: Policy<unknown, Post> = {
      ...allow<unknown, Post>(),
      run: (args) =>
        (args.row === null ? { allowed: true } : { allowed: 'yes' }) as unknown as ReturnType<
          Policy['run']
        >,
    };
    const out = await invoke(bulkEdit(lax), { ids: ['p1'] }, { ctx: ada() });
    expect(out).toEqual({
      allowed: [],
      denied: [{ id: 'p1', code: 'X_FORBIDDEN', reason: 'denied' }],
    });
  });
});
