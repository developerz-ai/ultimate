/**
 * The runs feature's rules, composed from its repo, its job and the queue. No HTTP here, which is
 * what lets one implementation serve the browser, the bearer mount and the MCP tool.
 *
 * `(ctx)` is left unannotated for the reason `posts/service.ts` gives: a factory is handed the
 * context's FACTS, and annotating `Ctx` would make the factory that builds `ctx.runs` need it.
 */

import { LIVE_RUN_STATUSES } from '@postly/db';
import { defineService } from '@ultimat3/core';
import type { JobDriver } from '@ultimat3/jobs';
import { cancelJob, jobDriver } from '@ultimat3/jobs';
import { answerPrompt as publishAnswer } from '@ultimat3/scraping';
import type { ConnectInput, ConnectionView, RunKeyIssued, RunStarted } from './entity';
import { ConnectionNotFound, RunNotFound, RunQueueUnavailable } from './errors';
import { syncConnection } from './jobs';
import { issueRunKeyFor, revokeRunKeyById, runKeyOwner } from './keys';
import type { RunOwner } from './policy';
import * as repo from './repo';

/** What a cancelled run's `failed` event carries: core's code for a cancelled attempt. */
const CANCELLED = 'X_ABORTED';

const queue = (what: string): JobDriver => {
  const driver = jobDriver();
  if (driver === undefined) throw new RunQueueUnavailable(what);
  return driver;
};

export const runsService = defineService('runs', (ctx) => ({
  async connect(input: ConnectInput): Promise<ConnectionView> {
    const row = await repo.insertConnection({
      orgId: input.orgId,
      label: input.label,
      credential: input.credential,
      exit: input.exit ?? null,
    });
    return { id: row.id, label: row.label, createdAt: row.createdAt };
  },

  /**
   * Put one sync on the queue, and the run's row beside it, and answer the handle the console
   * follows. The enqueue joins the request's transaction and both ids are the queue's own —
   * allocated when the job is staged — so the row and the job commit or vanish together.
   */
  async start(orgId: string, connectionId: string): Promise<RunStarted> {
    const connection = await repo.connectionById(connectionId);
    if (connection === null) throw new ConnectionNotFound(connectionId);
    const queued = await syncConnection.enqueue(
      { connectionId, orgId, requestId: crypto.randomUUID() },
      { tenantId: orgId },
    );
    await repo.insertRun({ id: queued.runId, orgId, connectionId, jobId: queued.id });
    return { runId: queued.runId, jobId: queued.id };
  },

  /** The prompt row an answer is for, as the fact `canRunAct` decides about. */
  async promptOwner(runId: string, prompt: number): Promise<RunOwner | null> {
    const row = await repo.promptEvent(runId, prompt);
    return row === null ? null : { orgId: row.orgId };
  },

  /** Sealed and published for that one prompt of that one run; the waiting run opens it. */
  async answer(runId: string, prompt: number, answer: string): Promise<void> {
    await publishAnswer({ runId, index: prompt, answer });
  },

  /** The run's row, as the fact `canRunAct` decides about. `null`: no such run in this org. */
  async runOwner(runId: string): Promise<RunOwner | null> {
    const row = await repo.runById(runId);
    return row === null ? null : { orgId: row.orgId };
  },

  /**
   * Stop the run and say so where the console reads it. The queue tells a job how a run ENDED
   * (`onSettled`), and a cancel is not an ending the worker reached: whoever cancels is the one
   * who knows, so the `failed` event is written here. A run that already ended is left as it is:
   * a second cancel writes no second ending.
   */
  async cancel(runId: string): Promise<void> {
    const run = await repo.runById(runId);
    if (run === null) throw new RunNotFound(runId);
    if (!LIVE_RUN_STATUSES.includes(run.status)) return;
    await cancelJob(queue('cancelling a run'), run.jobId, `cancelled by ${ctx.actor.id}`);
    await repo.appendEvent({ orgId: run.orgId, runId, kind: 'failed', message: CANCELLED });
  },

  issueKey(orgId: string): Promise<RunKeyIssued> {
    return issueRunKeyFor({ orgId, userId: ctx.actor.id, clock: ctx.clock });
  },

  keyOwner(keyId: string): Promise<RunOwner | null> {
    return runKeyOwner(keyId);
  },

  revokeKey(keyId: string): Promise<boolean> {
    return revokeRunKeyById(keyId, ctx.clock);
  },
}));
