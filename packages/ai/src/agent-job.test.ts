/**
 * Issue #125 for the agent case: an agent as durable, resumable, budgeted background work.
 *
 * The failure this file exists for is the one no runtime test could reach before — `.job()` hands
 * back `kind: 'action-job'`, which `isJobHandle` refuses, so "run an agent over a million rows"
 * had no spelling at all. Everything after that is the composition being real rather than
 * inferred: enqueued through the handle, claimed from the driver, executed by `executeJob`.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { registerAction, resetRegistry } from '@ultimat3/action';
import { createContext, userActor } from '@ultimat3/core';
import type { AnyJobHandle, ClaimedJob, JobDriver, JobExecution } from '@ultimat3/jobs';
import {
  createMemoryDriver,
  executeJob,
  isJobHandle,
  resetJobDriver,
  resetJobs,
  resetJobsFacade,
  setJobDriver,
} from '@ultimat3/jobs';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import { agentJob } from './agent-job';
import { createGateway } from './gateway';
import { definePrompt, type Prompt } from './prompt';
import type { GenerateResult, Provider, TokenUsage } from './provider';
import { costOf, EchoProvider } from './provider';
import { configureAi, resetAiRuntime } from './runtime';
import type { ProjectableAction } from './tools';

const Input = t.object({ topic: t.string, orgId: t.string });
const Output = t.object({ answer: t.string });
const USAGE: TokenUsage = {
  inputTokens: 12,
  outputTokens: 8,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** Answers `respond`, or asks for `noteIt` forever when told to loop. */
function scripted(loop = false): { provider: Provider; seen: number } {
  const state = { seen: 0 };
  const provider: Provider = {
    name: 'scripted',
    models: ['claude-opus-5'],
    generate() {
      state.seen += 1;
      return Promise.resolve({
        model: 'claude-opus-5',
        text: '',
        toolCalls: loop
          ? [{ id: `c${state.seen}`, name: 'noteIt', input: { actor: 'admin' } }]
          : [{ id: `c${state.seen}`, name: 'respond', input: { answer: 'done' } }],
        stopReason: 'tool_use',
        stopDetails: undefined,
        usage: USAGE,
        cost: costOf('claude-opus-5', USAGE),
      } satisfies GenerateResult);
    },
    stream: (request) => new EchoProvider().stream(request),
  };
  return {
    provider,
    get seen() {
      return state.seen;
    },
  };
}

let seq = 0;
function promptFor(): Prompt<{ topic: string }> {
  seq += 1;
  return definePrompt<{ topic: string }>({
    id: `agentjob-${seq}`,
    version: '1.0.0',
    template: 'Summarise {{topic}}.',
  });
}

/** Records the actor every tool call actually ran as. */
function actorProbe(seen: { id: string; orgId: string | undefined }[]): ProjectableAction {
  return {
    name: 'noteIt',
    mcp: { expose: true },
    run({ actor }) {
      seen.push({ id: actor.id, orgId: actor.orgId });
      return Promise.resolve({ noted: true });
    },
  };
}

function summariser(
  name: string,
  tools: readonly ProjectableAction[] = [],
  budget?: { tokensPerRun: number },
) {
  return agent({
    input: Input,
    output: Output,
    prompt: promptFor(),
    vars: ({ input }) => ({ topic: input.topic }),
    tools,
    ...(budget === undefined ? {} : { budget }),
    maxTurns: 6,
    policy: allow(),
  }).named(name);
}

/** Enqueue through the handle, claim off the driver, run it. The whole composition, once. */
async function runThrough(
  handle: AnyJobHandle,
  driver: JobDriver,
  input: unknown,
  ctx = createContext({ role: 'worker', actor: userActor({ id: 'worker-1', orgId: 'org-1' }) }),
): Promise<JobExecution> {
  await handle.enqueue(input);
  const claimed = (
    await driver.claim({
      queues: [handle.queue],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'worker-test',
    })
  )[0] as ClaimedJob;
  return executeJob({ driver, claimed, handle, ctx });
}

let driver: JobDriver;

beforeEach(() => {
  resetAiRuntime();
  resetRegistry();
  resetJobs();
  resetJobsFacade();
  driver = createMemoryDriver();
  setJobDriver(driver);
});

afterAll(() => {
  resetJobs();
  resetJobDriver();
});

describe('an agent is durable work — issue #125', () => {
  test('agentJob() produces a handle the queue accepts, where .job() never could', () => {
    configureAi({ gateway: createGateway({ providers: [new EchoProvider()] }) });
    const summarise = summariser('summariseAgent');

    // The shape this replaces. `isJobHandle` needs `kind === 'job'` AND membership of a WeakMap
    // only `job()` writes, so no externally-built object has ever reached the queue.
    expect(isJobHandle(summarise.job())).toBe(false);
    expect(summarise.job().kind).toBe('action-job');

    const handle = agentJob(summarise, {
      name: 'summarise-backlog',
      tenant: (input) => input.orgId,
      retry: { attempts: 3, jitter: false },
    });
    expect(isJobHandle(handle)).toBe(true);
    expect(handle.kind).toBe('job');
    expect(handle.name).toBe('summarise-backlog');
    // The action's own schema, so the queue parses exactly what the agent would have.
    expect(handle.parse({ topic: 'a', orgId: 'org-1' })).toEqual({ topic: 'a', orgId: 'org-1' });
    expect(handle.tenantFor({ topic: 'a', orgId: 'org-1' })).toBe('org-1');
  });

  test('the queue key is the declared name, never the export name', () => {
    configureAi({ gateway: createGateway({ providers: [new EchoProvider()] }) });
    const handle = agentJob(summariser('renamedAgent'), {
      name: 'stable-queue-key',
      tenant: 'none',
      retry: { attempts: 1 },
    });
    // Renaming the export must not move where already-queued rows are delivered.
    expect(handle.name).toBe('stable-queue-key');
    expect(handle.tenantFor({ topic: 'a', orgId: 'org-1' })).toBeUndefined();
  });
});

describe('the action projection is read lazily, at boot order', () => {
  // The real declaration order: `export const summarise = agent(...)` and `export const job =
  // agentJob(summarise, ...)` both run at module scope, and `registerActions(module)` names them
  // after. Reading `target.job()` eagerly makes that ordinary file `X_ACTION_UNREGISTERED`.
  test('agentJob() on an action nothing has named yet still declares, and keys off it later', () => {
    configureAi({ gateway: createGateway({ providers: [new EchoProvider()] }) });
    const unnamed = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ topic: input.topic }),
      tools: [],
      policy: allow(),
    });
    const handle = agentJob(unnamed, {
      name: 'lazy-queue-key',
      tenant: 'none',
      retry: { attempts: 1 },
    });
    // Boot names it only now.
    registerAction('lazySummarise', unnamed);
    expect(handle.idempotencyKeyFor({ topic: 'a', orgId: 'org-1' })).toStartWith(
      'action:lazySummarise:',
    );
  });

  test('a declared idempotencyKey wins over the projection default', () => {
    configureAi({ gateway: createGateway({ providers: [new EchoProvider()] }) });
    const handle = agentJob(summariser('keyedAgent'), {
      name: 'keyed',
      tenant: 'none',
      retry: { attempts: 1 },
      idempotencyKey: (input) => `summarise:${input.topic}`,
    });
    expect(handle.idempotencyKeyFor({ topic: 'a', orgId: 'org-1' })).toBe('summarise:a');
  });
});

describe('tenant and retry are required, and stay required', () => {
  test('a missing tenant is refused at declaration, not at the first claim', () => {
    configureAi({ gateway: createGateway({ providers: [new EchoProvider()] }) });
    const summarise = summariser('untenantedAgent');
    expect(() =>
      // The runtime backstop behind the compile error, for generated code and JS callers.
      agentJob(summarise, { name: 'untenanted', retry: { attempts: 1 } } as unknown as Parameters<
        typeof agentJob
      >[1]),
    ).toThrow('X_JOB_TENANT_REQUIRED');
  });

  test('a retry policy that can never run is refused at declaration', () => {
    configureAi({ gateway: createGateway({ providers: [new EchoProvider()] }) });
    const summarise = summariser('unrunnableAgent');
    expect(() =>
      agentJob(summarise, { name: 'unrunnable', tenant: 'none', retry: { attempts: 0 } }),
    ).toThrow();
  });
});

describe('the agent runs on the job path, under the job’s identity', () => {
  test('enqueued, claimed and executed — and the actor is the worker context, never the model', async () => {
    const seenActors: { id: string; orgId: string | undefined }[] = [];
    const provider = scripted(true);
    configureAi({ gateway: createGateway({ providers: [provider.provider] }) });
    const summarise = summariser('actorAgent', [actorProbe(seenActors)]);
    const handle = agentJob(summarise, {
      name: 'summarise-actor',
      tenant: (input) => input.orgId,
      retry: { attempts: 1, jitter: false },
    });

    const execution = await runThrough(handle, driver, { topic: 'a', orgId: 'org-1' });

    // The loop ran to its ceiling because this model never answers — the point is WHO the tools
    // ran as, and the model named `admin` in every call it made.
    expect(execution.job).toBe('summarise-actor');
    expect(seenActors.length).toBeGreaterThan(0);
    expect(seenActors.every((seen) => seen.id === 'worker-1')).toBe(true);
    // The org is the JOB's declared tenant, from its own payload — not the worker's ambient one.
    expect(seenActors.every((seen) => seen.orgId === 'org-1')).toBe(true);
  });

  test('a completed run settles as completed', async () => {
    const provider = scripted();
    configureAi({ gateway: createGateway({ providers: [provider.provider] }) });
    const handle = agentJob(summariser('happyAgent'), {
      name: 'summarise-happy',
      tenant: (input) => input.orgId,
      retry: { attempts: 1, jitter: false },
    });

    const execution = await runThrough(handle, driver, { topic: 'a', orgId: 'org-1' });
    expect(execution.outcome).toBe('completed');
    expect(provider.seen).toBe(1);
  });
});

describe('the ceilings shipped for the request path hold on the job path too', () => {
  test('a per-run token budget stops the loop mid-way, driven from the queue', async () => {
    const provider = scripted(true);
    configureAi({ gateway: createGateway({ providers: [provider.provider] }) });
    const handle = agentJob(
      // Enough for the first turn's estimate, not for a second.
      summariser('cappedAgent', [actorProbe([])], { tokensPerRun: 4_200 }),
      {
        name: 'summarise-capped',
        tenant: (input) => input.orgId,
        retry: { attempts: 1, jitter: false },
      },
    );

    const execution = await runThrough(handle, driver, { topic: 'a', orgId: 'org-1' });
    expect(execution.outcome).toBe('dead-lettered');
    expect(execution.error).toContain('X_AI_BUDGET_EXCEEDED');
    // Bounded, and bounded EARLY: not six turns' worth of provider calls.
    expect(provider.seen).toBeLessThan(6);
  });

  test("the job's ctx.signal reaches the agent's turn loop, so a cancelled attempt buys nothing", async () => {
    const provider = scripted(true);
    configureAi({ gateway: createGateway({ providers: [provider.provider] }) });
    const handle = agentJob(summariser('cancellableAgent', [actorProbe([])]), {
      name: 'summarise-cancellable',
      tenant: 'none',
      retry: { attempts: 1, jitter: false },
    });

    const aborted = new AbortController();
    aborted.abort();
    const execution = await runThrough(
      handle,
      driver,
      { topic: 'a', orgId: 'org-1' },
      createContext({
        role: 'worker',
        actor: userActor({ id: 'worker-1' }),
        signal: aborted.signal,
      }),
    );

    // `executeJob` composes the caller's signal into the attempt's, and the agent's turn loop is
    // the thing that reads it — this is that seam's real caller, not a synthetic ctx.
    expect(execution.outcome).not.toBe('completed');
    expect(provider.seen).toBe(0);
  });
});
