// The `agent` shape's actions: the read the agent calls as a tool (`postTitles`), the agent itself
// (`suggestTitle`, an `agent()` — a factory returning an action, so a route and an MCP tool like
// any other), and `draftPost`, the code that keeps what the agent suggested. Each with its test.

import type { GeneratedFile } from '../naming';
import { ASSISTANT_DIR } from './agent-model';

const DIR = `${ASSISTANT_DIR}/actions`;
const ORG = '00000000-0000-4000-8000-000000000002';
const OTHER_ORG = '00000000-0000-4000-8000-000000000009';

const postTitles =
  (): string => `// postTitles: the titles of the caller's newest posts. The read the assistant's agent calls as a
// tool, and an MCP client calls as the same tool — one declaration, one policy, both doors.

import { action, t } from '@ultimat3/action';
import { canPostRead } from '../../post/policy';
import * as repo from '../../post/repo';

export const postTitles = action({
  input: t.object({ limit: t.number.int().min(1).max(50).default(20) }),
  output: t.object({ titles: t.array(t.string) }),
  policy: canPostRead,
  mcp: {
    expose: true,
    description: "The titles of your organisation's newest posts, newest first",
  },
  async handle({ input }) {
    const rows = await repo.list(input.limit);
    return { titles: rows.map((row) => row.title) };
  },
});
`;

const postTitlesTest =
  (): string => `// postTitles against the in-memory driver: who may read, and what the agent is handed.
import { driver } from '@APP/db';
import { ctxOf, frozenClock, runWithContext } from '@ultimat3/core';
import { testActor } from '@ultimat3/policy';
import { afterEach, expect, unitTest } from '@ultimat3/testing';
import * as repo from '../../post/repo';
import { postTitles } from './post-titles';

const orgId = '${ORG}';
const target = postTitles.named('postTitles');
const reader = testActor('reader', { orgId, permissions: ['post:read'] }).actor;

afterEach(() => {
  driver.reset?.();
});

unitTest('a caller without the read grant is refused', async () => {
  const stranger = testActor('stranger', { orgId }).actor;
  await expect(target.as(stranger, {})).rejects.toBeUltimateError('X_FORBIDDEN');
});

unitTest("the org's titles, newest first, as many as asked", async () => {
  const at = (instant: string) => ctxOf({ actor: reader, clock: frozenClock(instant) });
  for (const [title, instant] of [
    ['older', '2026-01-01T00:00:00.000Z'],
    ['newer', '2026-01-02T00:00:00.000Z'],
  ] as const) {
    const draft = { orgId, title, price: { minor: 0, currency: 'USD' } };
    await runWithContext(at(instant), () => repo.insert(draft));
  }
  expect(await target.as(reader, {})).toEqual({ titles: ['newer', 'older'] });
  expect(await target.as(reader, { limit: 1 })).toEqual({ titles: ['newer'] });
});
`;

const suggestTitle =
  (): string => `// suggestTitle: the assistant. An \`agent()\` — a factory that RETURNS an action, so it has a route,
// an MCP tool and a job (\`../jobs/draft-post-later.ts\`) like any other. Its one tool is an action
// too, run under the SAME actor through its own policy: the model reads what the caller may read.
// It writes nothing: what it suggests is kept by \`draftPost\`, under an id the CODE was given.

import { t } from '@ultimat3/action';
import { agent } from '@ultimat3/ai';
import { canPostWrite } from '../../post/policy';
import { suggestTitlePrompt } from '../prompts/suggest-title';
import { postTitles } from './post-titles';

export const suggestTitle = agent({
  input: t.object({ orgId: t.uuid, topic: t.string.min(1).max(200) }),
  output: t.object({ title: t.string.min(1).max(200) }),
  prompt: suggestTitlePrompt,
  // The topic verbatim: the prompt fences it as \`<topic>\` DATA, never instructions.
  vars: ({ input, ctx }) => ({ topic: input.topic, locale: ctx.locale }),
  tools: [postTitles],
  // A read, then an answer — and one turn of slack. Reaching the ceiling is X_AGENT_MAX_TURNS.
  maxTurns: 3,
  maxToolResultChars: 4000,
  maxTokens: 512,
  budget: { tokensPerRun: 16_000 },
  // A suggestion is for a post the caller may write, in the org the input names.
  policy: canPostWrite,
  mcp: {
    expose: true,
    description:
      'Suggest a title for a new post about a topic, unlike every title your organisation has',
  },
});
`;

const suggestTitleTest =
  (): string => `// suggestTitle on the scripted model: the tool it calls, the answer parsed into its schema, and a
// refusal decided before a single token is spent.
import { driver } from '@APP/db';
import { testActor } from '@ultimat3/policy';
import { afterEach, expect, swapAdapter, unitTest } from '@ultimat3/testing';
import { api } from '../../../api/index';
import { scriptedGateway } from '../scripted-model';

const orgId = '${ORG}';
const writer = testActor('writer', { orgId, permissions: ['post:read', 'post:write'] }).actor;
const input = { orgId, topic: 'How we review a pull request' };

afterEach(() => {
  driver.reset?.();
});

unitTest('it reads the titles through its tool, then answers one', async () => {
  const { model, gateway } = scriptedGateway([
    { call: 'postTitles', input: {} },
    { answer: { title: 'Two readers, one diff' } },
  ]);
  await swapAdapter('aiGateway', gateway);
  expect(await api.actions.suggestTitle.as(writer, input)).toEqual({
    title: 'Two readers, one diff',
  });
  // The topic reached the model, and the tool's answer reached its second turn.
  expect(JSON.stringify(model.seen[0]?.messages)).toContain(input.topic);
  expect(JSON.stringify(model.seen[1]?.messages)).toContain('titles');
});

unitTest('a writer of another org is refused, at no cost', async () => {
  const { model, gateway } = scriptedGateway([]);
  await swapAdapter('aiGateway', gateway);
  const stranger = testActor('stranger', {
    orgId: '${OTHER_ORG}',
    permissions: ['post:write'],
  });
  await expect(api.actions.suggestTitle.as(stranger.actor, input)).rejects.toBeUltimateError(
    'X_FORBIDDEN',
  );
  expect(model.seen).toEqual([]);
});
`;

const draftPost =
  (): string => `// draftPost: the assistant's suggestion, kept. \`suggestTitle\` runs as the caller, and the post is
// written by this code under the id the CALLER chose — never one the model names. Idempotent by
// that id: a queued attempt replayed after its worker died finds the post and answers it, and the
// model is not asked twice.

import { action, t } from '@ultimat3/action';
import { PostView } from '../../post/entity';
import { canPostWrite, postTag } from '../../post/policy';
import * as repo from '../../post/repo';
import * as service from '../../post/service';
import { suggestTitle } from './suggest-title';

export const draftPost = action({
  input: t.object({ id: t.uuid, orgId: t.uuid, topic: t.string.min(1).max(200), price: t.money }),
  output: PostView,
  policy: canPostWrite,
  cache: { invalidates: [postTag] },
  async handle({ input, ctx }) {
    const kept = await repo.byId(input.id);
    if (kept !== undefined) return kept;
    const { orgId, topic } = input;
    const { output } = await suggestTitle.run({ orgId, topic }, { actor: ctx.actor });
    return service.create({ id: input.id, orgId, title: output.title, price: input.price });
  },
});
`;

const draftPostTest =
  (): string => `// draftPost: the post written under the caller's id with the agent's title — and once only.
import { driver } from '@APP/db';
import { testActor } from '@ultimat3/policy';
import { afterEach, expect, swapAdapter, unitTest } from '@ultimat3/testing';
import { api } from '../../../api/index';
import { scriptedGateway } from '../scripted-model';

const orgId = '${ORG}';
const writer = testActor('writer', { orgId, permissions: ['post:read', 'post:write'] }).actor;
const input = {
  id: '00000000-0000-4000-8000-0000000000d1',
  orgId,
  topic: 'How we review a pull request',
  price: { minor: 0, currency: 'USD' },
};

afterEach(() => {
  driver.reset?.();
});

unitTest('the suggested title is kept under the id the caller chose, once', async () => {
  // Two turns: one run. A second run would be X_AI_SCRIPT_EXHAUSTED, never a second post.
  const { model, gateway } = scriptedGateway([
    { call: 'postTitles', input: {} },
    { answer: { title: 'Two readers, one diff' } },
  ]);
  await swapAdapter('aiGateway', gateway);
  const first = await api.actions.draftPost.as(writer, input);
  expect(first).toMatchObject({ id: input.id, title: 'Two readers, one diff', price: input.price });
  expect(await api.actions.draftPost.as(writer, input)).toEqual(first);
  expect(model.seen).toHaveLength(2);
});
`;

/** `apps/web/app/assistant/actions/`: the tool, the agent, the keeper, and their tests. */
export function actionFiles(scope: string): readonly GeneratedFile[] {
  const own = (text: string): string => text.replaceAll('@APP/', `@${scope}/`);
  return [
    { path: `${DIR}/post-titles.ts`, contents: postTitles() },
    { path: `${DIR}/post-titles.test.ts`, contents: own(postTitlesTest()) },
    { path: `${DIR}/suggest-title.ts`, contents: suggestTitle() },
    { path: `${DIR}/suggest-title.test.ts`, contents: own(suggestTitleTest()) },
    { path: `${DIR}/draft-post.ts`, contents: draftPost() },
    { path: `${DIR}/draft-post.test.ts`, contents: own(draftPostTest()) },
  ];
}
