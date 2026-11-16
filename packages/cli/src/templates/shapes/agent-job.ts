// The `agent` shape's long run: `draftPost` as an `agentJob()` — a factory over `job()` — acting as
// the org's assistant, and `queueDraft`, the action (and MCP tool) that enqueues it. Each with its
// test: the declaration in the `job` suite, the whole run through the queue in `unit`.

import type { GeneratedFile } from '../naming';
import { ASSISTANT_DIR } from './agent-model';

const ORG = '00000000-0000-4000-8000-000000000002';

const job =
  (): string => `// draftPostLater: \`draftPost\` as durable background work — a model run is tens of seconds, never
// inside a client's wait. \`agentJob()\` is a factory over \`job()\`, so the queue, the retries, the
// dead-letter path and \`x jobs show\` are the framework's.
//
// A worker's own actor is nobody, so the run acts as the org's ASSISTANT: an agent actor of the org
// its input names, holding the \`assistant\` role \`shared/roles.ts\` grants — re-made on every
// attempt, never trusted from the payload. The write it makes is \`draftPost\`'s, idempotent by id.

import { agentJob } from '@ultimat3/ai';
import { agentActor } from '@ultimat3/core';
import { draftPost } from '../actions/draft-post';

/** Who a queued draft acts as: the org's assistant, and only in that org. */
export const assistantActor = (orgId: string) =>
  agentActor({ id: 'assistant', orgId, roles: ['assistant'] });

export const draftPostLater = agentJob(draftPost, {
  name: 'assistant.draft-post',
  tenant: (input) => input.orgId,
  retry: { attempts: 3, backoff: 'exponential' },
  idempotencyKey: (input) => \`assistant.draft-post:\${input.id}\`,
  actor: ({ input }) => assistantActor(input.orgId),
});
`;

const jobSuite =
  (): string => `// draftPostLater's declaration against a real queue driver: its key, its tenant, its dedupe. The
// run itself — the agent, the tool, the write — is \`draft-post-later.test.ts\`'s.
import { memoryJobDriver } from '@ultimat3/jobs';
import { beforeAll, expect, jobTest, swapAdapter } from '@ultimat3/testing';
import { draftPostLater } from './draft-post-later';

const input = {
  id: '00000000-0000-4000-8000-0000000000d1',
  orgId: '${ORG}',
  topic: 'How we review a pull request',
  price: { minor: 0, currency: 'USD' },
};

beforeAll(() => swapAdapter('jobs', memoryJobDriver()));

jobTest('one queued draft per post id, under the org its input names', () => {
  expect(draftPostLater.name).toBe('assistant.draft-post');
  expect(draftPostLater.idempotencyKeyFor(input)).toBe(\`assistant.draft-post:\${input.id}\`);
  expect(draftPostLater.tenantFor(input)).toBe(input.orgId);
  expect(draftPostLater.retry.attempts).toBe(3);
});

jobTest('a second enqueue of the same draft is the same row', async () => {
  expect((await draftPostLater.enqueue(input)).deduped).toBe(false);
  expect((await draftPostLater.enqueue(input)).deduped).toBe(true);
});
`;

const jobRunTest =
  (): string => `// draftPostLater run by a worker in this process: no actor at all, so what this pins is that the
// run authorises as the org's assistant, calls its tool, and writes the post it was given the id of.
import { driver } from '@APP/db';
import { ctxOf, runWithContext } from '@ultimat3/core';
import { testActor } from '@ultimat3/policy';
import { afterEach, expect, swapAdapter, unitTest } from '@ultimat3/testing';
import '../../../api/index';
import '../../../shared/roles';
import * as repo from '../../post/repo';
import { scriptedGateway } from '../scripted-model';
import { assistantActor, draftPostLater } from './draft-post-later';

const orgId = '${ORG}';
const input = {
  id: '00000000-0000-4000-8000-0000000000d1',
  orgId,
  topic: 'How we review a pull request',
  price: { minor: 0, currency: 'USD' },
};

afterEach(() => {
  driver.reset?.();
});

unitTest('the assistant is an agent of the org its input names', () => {
  expect(assistantActor(orgId)).toMatchObject({ kind: 'agent', orgId, roles: ['assistant'] });
});

unitTest('a queued draft runs as the assistant and keeps the post', async ({ runJobs }) => {
  const { gateway } = scriptedGateway([
    { call: 'postTitles', input: {} },
    { answer: { title: 'Two readers, one diff' } },
  ]);
  await swapAdapter('aiGateway', gateway);
  const trace = await runJobs(draftPostLater, input);
  expect(trace.executions.map((run) => run.outcome)).toEqual(['completed']);
  const reader = ctxOf({ actor: testActor('reader', { orgId }).actor });
  const kept = await runWithContext(reader, () => repo.byId(input.id));
  expect(kept?.title).toBe('Two readers, one diff');
});
`;

const queueDraft =
  (): string => `// queueDraft: ask the assistant for a post in the background. Answers at once with the id the post
// will have; \`postList\` shows it when the run lands. The tool an MCP client calls to start a long
// agent run without waiting on it.

import { action, t } from '@ultimat3/action';
import { orgOf } from '../../post/actions/create-post';
import { canPostCreate } from '../../post/policy';
import { draftPostLater } from '../jobs/draft-post-later';

export const queueDraft = action({
  input: t.object({ topic: t.string.min(1).max(200), price: t.money }),
  output: t.object({ id: t.uuid, jobId: t.string }),
  policy: canPostCreate,
  mcp: {
    expose: true,
    description:
      'Draft a post about a topic in the background: the assistant titles it, and it appears in postList under the id answered',
  },
  async handle({ input, ctx }) {
    // The id is the code's, chosen before the run: what makes a replayed run one post, not two.
    const id = crypto.randomUUID();
    const queued = await draftPostLater.enqueue({ id, orgId: orgOf(ctx.actor), ...input });
    return { id, jobId: queued.id };
  },
});
`;

const queueDraftTest =
  (): string => `// queueDraft: one job enqueued under the caller's org, answered with the post's future id.
import { memoryJobDriver } from '@ultimat3/jobs';
import { testActor } from '@ultimat3/policy';
import { beforeAll, expect, swapAdapter, unitTest } from '@ultimat3/testing';
import { queueDraft } from './queue-draft';

const orgId = '${ORG}';
const target = queueDraft.named('queueDraft');
const input = { topic: 'How we review a pull request', price: { minor: 0, currency: 'USD' } };

beforeAll(() => swapAdapter('jobs', memoryJobDriver()));

unitTest('a writer gets the id the post will have, and a job to wait on', async () => {
  const writer = testActor('writer', { orgId, permissions: ['post:write'] }).actor;
  const queued = await target.as(writer, input);
  expect(queued.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(queued.jobId).not.toBe('');
});

unitTest('a reader may not ask for a post', async () => {
  const reader = testActor('reader', { orgId, permissions: ['post:read'] }).actor;
  await expect(target.as(reader, input)).rejects.toBeUltimateError('X_FORBIDDEN');
});
`;

export function jobFiles(scope: string): readonly GeneratedFile[] {
  const own = (text: string): string => text.replaceAll('@APP/', `@${scope}/`);
  return [
    { path: `${ASSISTANT_DIR}/jobs/draft-post-later.ts`, contents: job() },
    { path: `${ASSISTANT_DIR}/jobs/draft-post-later.job.test.ts`, contents: jobSuite() },
    { path: `${ASSISTANT_DIR}/jobs/draft-post-later.test.ts`, contents: own(jobRunTest()) },
    { path: `${ASSISTANT_DIR}/actions/queue-draft.ts`, contents: queueDraft() },
    { path: `${ASSISTANT_DIR}/actions/queue-draft.test.ts`, contents: queueDraftTest() },
  ];
}
