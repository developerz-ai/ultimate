/**
 * contract — `draftReview`, the app's one long tool, driven over the MCP wire only: the call
 * queues the review and answers `running` with the next call; once the worker drains, `job_status`
 * answers `done` with `postReview`'s row read as the caller. The job ran for the CALLER's member
 * (`jobInput`), and another member — same org or not — reads the same not-found as an id nobody
 * issued.
 */

import { configureAi, providerGateway, scriptedProvider } from '@ultimat3/ai';
import { agentActor } from '@ultimat3/core';
import { expect, test } from '@ultimat3/testing';
import { webMcp } from './mcp-tools';

interface Member {
  readonly id: string;
  readonly [column: string]: unknown;
}

/** An agent acting for a member: the member row's id, org and role, as `actorFor` builds them. */
const agentFor = (member: Member) => ({
  actor: agentActor({
    id: member.id,
    orgId: String(member['orgId']),
    roles: [String(member['role'])],
  }),
  scopes: new Set<string>(),
});

let nextId = 0;
const toolCall = (name: string, args: Record<string, unknown>) => {
  nextId += 1;
  return {
    jsonrpc: '2.0' as const,
    id: nextId,
    method: 'tools/call',
    params: { name, arguments: args },
  };
};

interface ToolCallResponse {
  readonly result?: {
    readonly content?: readonly { readonly text?: string }[];
    readonly isError?: boolean;
  };
}

const textOf = (response: unknown): string =>
  (response as ToolCallResponse).result?.content?.[0]?.text ?? '';

test('draftReview answers running, and job_status reaches done with the kept review', async ({
  seed,
  runJobs,
}) => {
  const { draft, bruno } = await seed('dev').pick({
    draft: 'post:draft-money', // Bruno's
    bruno: 'member:bruno',
  });
  configureAi({
    gateway: providerGateway({
      providers: [
        scriptedProvider({ turns: [{ answer: { verdict: 'ready', notes: 'Ship it.' } }] }),
      ],
    }),
  });
  const mcp = webMcp();
  const args = { postId: draft.id, orgId: draft.orgId };

  const started = JSON.parse(
    textOf(await mcp.server.handle(toolCall('draftReview', args), agentFor(bruno))),
  ) as { status: string; jobId: string; poll: { tool: string; arguments: { jobId: string } } };
  expect(started.status).toBe('running');
  expect(started.poll).toEqual({ tool: 'job_status', arguments: { jobId: started.jobId } });

  // No `actor`: the worker is nobody, as in production. The run re-reads the member it was given.
  const trace = await runJobs.drain();
  expect(trace.executions.map((execution) => execution.outcome)).toEqual(['completed']);

  const done = JSON.parse(
    textOf(
      await mcp.server.handle(toolCall('job_status', started.poll.arguments), agentFor(bruno)),
    ),
  ) as { status: string; result: readonly { verdict: string; reviewedBy: string }[] };
  expect(done.status).toBe('done');
  expect(done.result[0]?.verdict).toBe('ready');
  // The member the review was kept for is the CALLER — never a field the agent could fill in.
  expect(done.result[0]?.reviewedBy).toBe(bruno.id);
});

test('another member, in the org or not, reads the same not-found as an unknown id', async ({
  seed,
  // Installs the queue the tool enqueues on; nothing is drained here.
  runJobs: _queue,
}) => {
  const { draft, bruno, ada, mara } = await seed('dev').pick({
    draft: 'post:draft-money',
    bruno: 'member:bruno',
    ada: 'member:ada', // Bruno's org
    mara: 'member:mara', // another org
  });
  const mcp = webMcp();
  const started = JSON.parse(
    textOf(
      await mcp.server.handle(
        toolCall('draftReview', { postId: draft.id, orgId: draft.orgId }),
        agentFor(bruno),
      ),
    ),
  ) as { jobId: string };

  const statusAs = async (member: Member, jobId: string): Promise<string> =>
    textOf(await mcp.server.handle(toolCall('job_status', { jobId }), agentFor(member))).replace(
      jobId,
      '<id>',
    );
  const unknown = await statusAs(bruno, '00000000-0000-7000-8000-000000000000');
  expect(unknown).toContain('X_JOB_NOT_FOUND');
  expect(await statusAs(ada, started.jobId)).toBe(unknown);
  expect(await statusAs(mara, started.jobId)).toBe(unknown);
});

test('one MCP path to the review job: draftReview, never the action that also queues it', async ({
  seed,
}) => {
  const { bruno } = await seed('dev').pick({ bruno: 'member:bruno' });
  const listed = (await webMcp().server.handle(
    { jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} },
    agentFor(bruno),
  )) as { result?: { tools?: readonly { name: string }[] } };
  const names = (listed.result?.tools ?? []).map((tool) => tool.name);
  expect(names).toContain('draftReview');
  expect(names).toContain('job_status');
  // `requestDraftReview` queues the same `reviewDraftLater` for the UI; exposed too, it was a
  // second way for an agent to start the same run, and one that never answered the review.
  expect(names).not.toContain('requestDraftReview');
});
