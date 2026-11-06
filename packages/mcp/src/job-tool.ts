/**
 * `jobTool()` — an MCP tool for work longer than a client waits: enqueue at once, wait up to
 * `inlineMs`, then answer the app's `result` query as the caller, or `running` with the next call
 * (`job_status`). A factory over a hand-written tool composing `job` and `query`.
 */

import type { Ctx } from '@ultimat3/core';
import { useContext } from '@ultimat3/core';
import type { AnyJobHandle, JobIntrospection, JobRecord } from '@ultimat3/jobs';
import { callerFailure, isJobHandle, jobDriver } from '@ultimat3/jobs';
import type { KnownPermission } from '@ultimat3/policy';
import type { AnyQuery } from '@ultimat3/query';
import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import type { AnyAppToolDefinition } from './app-tool';
import { McpJobToolInvalidError } from './job-tool-errors';

export const JOB_STATUS_TOOL = 'job_status';
export const JOB_TOOL_POLL_MS = 250;
export const JOB_TOOL_INLINE_MS = 5_000;
/** Past this an MCP client has usually given up: an answer it never reads is no answer. */
export const JOB_TOOL_INLINE_CEILING_MS = 25_000;

/** Waits `ms` or until `signal` aborts. The seam a test hands a frozen clock's `advance`. */
export type JobToolWait = (ms: number, signal: AbortSignal) => Promise<void>;

export interface JobToolDef<TInput extends StandardSchemaV1 = StandardSchemaV1> {
  readonly job: AnyJobHandle;
  readonly description: string;
  /** Who may START it, and who may read its status — the same permission, the same gate. */
  readonly policy: KnownPermission;
  /** The tool's input. Default: the job's own input schema. */
  readonly input?: TInput;
  /**
   * The job's input, from the tool's and the caller's request — a member id read off the caller,
   * never a field an agent fills in. Default: the tool's input, unchanged.
   */
  readonly jobInput?: (input: InferOutput<TInput>, ctx: Ctx) => unknown;
  /** Where the answer is read from, as the caller: the job writes where this query reads. */
  readonly result: AnyQuery;
  /** The `result` query's input. Default: the tool's input. */
  readonly resultInput?: (input: unknown) => unknown;
  /** How long to answer inline before `running`. Default 5,000 ms, at most 25,000. */
  readonly inlineMs?: number;
  readonly wait?: JobToolWait;
}

/** What `job_status` needs of a job tool, found again by the brand on its definition. */
export interface JobToolBrand {
  readonly job: AnyJobHandle;
  readonly result: AnyQuery;
  readonly resultInput: (input: unknown) => unknown;
  readonly policy: KnownPermission;
}

const BRANDS = new WeakMap<object, JobToolBrand>();

export const jobToolBrand = (def: object): JobToolBrand | undefined => BRANDS.get(def);

export type JobToolAnswer =
  | { readonly status: 'done'; readonly jobId: string; readonly result: unknown }
  | {
      readonly status: 'running';
      readonly jobId: string;
      readonly poll: { readonly tool: string; readonly arguments: { readonly jobId: string } };
    }
  | {
      readonly status: 'failed';
      readonly jobId: string;
      readonly code: string;
      /** The thrown error's declared `callerFix`; absent when it declared none. */
      readonly callerFix?: string;
    };

export function jobTool<TInput extends StandardSchemaV1 = StandardSchemaV1>(
  def: JobToolDef<TInput>,
): AnyAppToolDefinition {
  if (!isJobHandle(def.job)) {
    throw new McpJobToolInvalidError({ reason: "was given a job that is not job()'s handle" });
  }
  const inlineMs = def.inlineMs ?? JOB_TOOL_INLINE_MS;
  if (!Number.isSafeInteger(inlineMs) || inlineMs < 0 || inlineMs > JOB_TOOL_INLINE_CEILING_MS) {
    throw new McpJobToolInvalidError({
      reason: `was given inlineMs ${String(inlineMs)}; it must be a whole number of ms, 0 to ${String(JOB_TOOL_INLINE_CEILING_MS)}`,
    });
  }
  const resultInput = def.resultInput ?? ((input: unknown) => input);
  // `handle` is given `def.input` parsed — `TInput`'s output — so this widening restates no type.
  const jobInput = (def.jobInput ?? ((input: unknown) => input)) as (
    input: unknown,
    ctx: Ctx,
  ) => unknown;
  const wait = def.wait ?? realWait;
  // Bounded by polls as well as by the clock: a clock that does not move (a frozen test clock, a
  // stalled monotonic source) must still end the wait, or the call never answers at all.
  const polls = Math.ceil(inlineMs / JOB_TOOL_POLL_MS);
  const tool: AnyAppToolDefinition = {
    description: `${def.description} Long-running: answers inline when it can, else { status: 'running', poll } — call ${JOB_STATUS_TOOL} with that jobId.`,
    input: def.input ?? def.job.input,
    policy: def.policy,
    destructive: true,
    async handle({ input, ctx }) {
      const introspect = introspection();
      const queued = await def.job.as(ctx.actor, await jobInput(input, ctx));
      const started = ctx.clock.monotonic();
      for (let polled = 0; ; polled += 1) {
        const row = await introspect.job(queued.id);
        const answer = row === undefined ? undefined : await settled(row, def.result, resultInput);
        if (answer !== undefined) return answer;
        // A client that drops loses nothing: the job is queued, and `job_status` reads it later.
        if (ctx.signal.aborted) return running(queued.id);
        if (polled >= polls || ctx.clock.monotonic() - started >= inlineMs) {
          return running(queued.id);
        }
        await wait(Math.min(JOB_TOOL_POLL_MS, inlineMs), ctx.signal);
      }
    },
  };
  BRANDS.set(tool, { job: def.job, result: def.result, resultInput, policy: def.policy });
  return tool;
}

/** The driver's operator surface, or the refusal: a long tool that cannot report is not one. */
export function introspection(): JobIntrospection {
  const introspect = jobDriver()?.introspect;
  if (introspect === undefined) {
    throw new McpJobToolInvalidError({
      reason: 'needs a jobs driver with introspect, and the installed one has none',
    });
  }
  return introspect;
}

export function running(jobId: string): JobToolAnswer {
  return { status: 'running', jobId, poll: { tool: JOB_STATUS_TOOL, arguments: { jobId } } };
}

/**
 * A finished row's answer, or `undefined` while it runs. `done` reads `result` AS THE CALLER (its
 * own policy decides); `failed` carries the code and a declared `callerFix` alone — a row's text
 * is the worker's, and its developer `fix` names what only the app's author can run.
 */
export async function settled(
  row: JobRecord,
  result: AnyQuery,
  resultInput: (input: unknown) => unknown,
): Promise<JobToolAnswer | undefined> {
  if (row.state === 'done') {
    const caller = useContext().actor;
    const rows = await result.as(caller, resultInput(row.input), { surface: 'mcp' });
    return { status: 'done', jobId: row.id, result: rows };
  }
  if (row.state === 'failed' || row.state === 'dead' || row.state === 'cancelled') {
    return { status: 'failed', jobId: row.id, ...callerFailure(row.lastError) };
  }
  return undefined;
}

const realWait: JobToolWait = (ms, signal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
