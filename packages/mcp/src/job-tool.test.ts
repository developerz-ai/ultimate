// `jobTool()` on the memory driver, a frozen clock and a worker the test ticks: a fast job answers
// inline with the `result` query's rows, a slow one answers `running` and `job_status` reaches
// `done`, a repeated call attaches to the live run, and another caller's job is not-found.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { ctxOf, frozenClock, runWithContext, UltimateError, userActor } from '@ultimat3/core';
import type { MemoryJobDriver } from '@ultimat3/jobs';
import { job, jobWorker, memoryJobDriver, resetJobs } from '@ultimat3/jobs';
import { installJobDriver, resetJobDriver } from '@ultimat3/jobs/adapter';
import type { AnyQuery } from '@ultimat3/query';
import { t } from '@ultimat3/schema';
import { defineAppMcp } from './app-tools';
import type { JobToolWait } from './job-tool';
import { jobTool } from './job-tool';
import type { AnyMcpTool, McpToolResult } from './registry';

const clock = frozenClock('2026-11-06T00:00:00.000Z');
let driver: MemoryJobDriver;
let finished: string[];

/** The app's read of where the job wrote, run as whoever asks — it records who that was. */
const readers: (string | null)[] = [];
const report = {
  as: (actor: Actor | null, input: unknown) => {
    readers.push(actor?.id ?? null);
    return Promise.resolve([{ report: (input as { name: string }).name, rows: finished.length }]);
  },
} as unknown as AnyQuery;

let seq = 0;
function build(runs: number) {
  seq += 1;
  const reindex = job({
    tenant: 'none',
    name: `reindex${String(seq)}`,
    input: t.object({ name: t.string }),
    idempotencyKey: (input: { name: string }) => `reindex:${input.name}`,
    retry: { attempts: 1 },
    async run({ input }) {
      finished.push(input.name);
    },
  });
  const worker = jobWorker({
    driver,
    clock,
    context: () => ctxOf({ role: 'worker' }),
    drainOnShutdown: false,
  });
  let ticks = 0;
  // Each wait advances the frozen clock; the worker runs the job only once `runs` waits passed.
  const wait: JobToolWait = async (ms) => {
    clock.advance(ms);
    ticks += 1;
    if (ticks >= runs) await worker.tick();
  };
  const mcp = defineAppMcp({
    tools: {
      reindex: jobTool({
        job: reindex,
        policy: 'catalog:admin',
        description: 'Reindex.',
        result: report,
        inlineMs: 1_000,
        wait,
      }),
    },
  });
  return { mcp, worker };
}

const admin = (id: string, orgId = 'o1'): Actor =>
  userActor({ id, orgId, permissions: ['catalog:admin'] });
const caller = (actor: Actor) => ({ actor, scopes: new Set<string>() });
const tool = (tools: readonly AnyMcpTool[], name: string): AnyMcpTool =>
  tools.find((candidate) => candidate.name === name) ?? expect.unreachable(`no ${name}`);
const json = (result: McpToolResult): unknown =>
  JSON.parse(result.content.map((block) => (block.type === 'text' ? block.text : '')).join(''));
const inRequest = <T>(fn: () => Promise<T>): Promise<T> => runWithContext(ctxOf({ clock }), fn);

beforeEach(() => {
  driver = memoryJobDriver({ clock });
  installJobDriver(driver);
  finished = [];
  readers.length = 0;
});
afterEach(() => {
  resetJobDriver();
  resetJobs();
});

describe('jobTool()', () => {
  test('a job that settles inside inlineMs answers inline with the result query, as the caller', async () => {
    const { mcp } = build(1);
    const answer = json(
      await inRequest(() =>
        tool(mcp.tools, 'reindex').handle({ name: 'shop' }, caller(admin('u1'))),
      ),
    );
    expect(answer).toMatchObject({ status: 'done', result: [{ report: 'shop', rows: 1 }] });
    expect(readers).toEqual(['u1']);
  });

  test('a slow job answers running with the next call, and job_status reaches done', async () => {
    const { mcp, worker } = build(1_000);
    const first = json(
      await inRequest(() =>
        tool(mcp.tools, 'reindex').handle({ name: 'shop' }, caller(admin('u1'))),
      ),
    ) as {
      status: string;
      jobId: string;
      poll: { tool: string; arguments: { jobId: string } };
    };
    expect(first.status).toBe('running');
    expect(first.poll).toEqual({ tool: 'job_status', arguments: { jobId: first.jobId } });
    expect(finished).toEqual([]);
    await worker.tick();
    const later = json(
      await inRequest(() =>
        tool(mcp.tools, 'job_status').handle(first.poll.arguments, caller(admin('u1'))),
      ),
    );
    expect(later).toMatchObject({
      status: 'done',
      jobId: first.jobId,
      result: [{ report: 'shop' }],
    });
  });

  test('a repeated call attaches to the live run instead of queueing a second', async () => {
    const { mcp } = build(1_000);
    const call = () =>
      inRequest(() =>
        tool(mcp.tools, 'reindex').handle({ name: 'shop' }, caller(admin('u1'))),
      ).then(json);
    const [a, b] = (await Promise.all([call(), call()])) as { jobId: string }[];
    expect(a?.jobId).toBe(b?.jobId ?? '');
  });

  test('another actor, another org and an unknown id read the same not-found', async () => {
    const { mcp } = build(1_000);
    const started = json(
      await inRequest(() =>
        tool(mcp.tools, 'reindex').handle({ name: 'shop' }, caller(admin('u1'))),
      ),
    ) as { jobId: string };
    const status = tool(mcp.tools, 'job_status');
    const refusal = async (actor: Actor, jobId: string): Promise<string> => {
      try {
        await inRequest(() => status.handle({ jobId }, caller(actor)));
      } catch (error) {
        return JSON.stringify({
          code: (error as { code?: string }).code,
          cause: String((error as { cause?: unknown }).cause).replace(jobId, '<id>'),
        });
      }
      return expect.unreachable('job_status answered a job that is not the caller’s');
    };
    const unknown = await refusal(admin('u1'), '00000000-0000-7000-8000-000000000000');
    expect(unknown).toContain('X_JOB_NOT_FOUND');
    expect(await refusal(admin('u2'), started.jobId)).toBe(unknown);
    expect(await refusal(admin('u1', 'o2'), started.jobId)).toBe(unknown);
  });

  test('job_status is projected once, only beside a job tool, and needs no scope', () => {
    const { mcp } = build(1);
    expect(mcp.tools.filter((candidate) => candidate.name === 'job_status')).toHaveLength(1);
    const plain = defineAppMcp({ tools: {} });
    expect(plain.tools.some((candidate) => candidate.name === 'job_status')).toBe(false);
  });

  test('inlineMs past the ceiling, or a job that is not a handle, is refused at declaration', () => {
    const { mcp } = build(1);
    expect(mcp).toBeDefined();
    const reindex = job({
      tenant: 'none',
      name: 'ceiling',
      input: t.object({}),
      idempotencyKey: () => 'k',
      retry: { attempts: 1 },
      async run() {},
    });
    expect(() =>
      jobTool({
        job: reindex,
        policy: 'catalog:admin',
        description: 'x',
        result: report,
        inlineMs: 30_000,
      }),
    ).toThrow(expect.objectContaining({ code: 'X_MCP_JOB_TOOL_INVALID' }));
    expect(() =>
      jobTool({
        job: { kind: 'job' } as unknown as typeof reindex,
        policy: 'catalog:admin',
        description: 'x',
        result: report,
      }),
    ).toThrow(expect.objectContaining({ code: 'X_MCP_JOB_TOOL_INVALID' }));
  });

  test('a failed job crosses as its code alone — the worker’s text stays in the row', async () => {
    seq += 1;
    const failing = job({
      tenant: 'none',
      name: `failing${String(seq)}`,
      input: t.object({}),
      idempotencyKey: () => 'once',
      retry: { attempts: 1 },
      run() {
        return Promise.reject(new Error('db password is hunter2'));
      },
    });
    const worker = jobWorker({
      driver,
      clock,
      context: () => ctxOf({ role: 'worker' }),
      drainOnShutdown: false,
    });
    const mcp = defineAppMcp({
      tools: {
        fail: jobTool({
          job: failing,
          policy: 'catalog:admin',
          description: 'Fails.',
          result: report,
          wait: async (ms) => {
            clock.advance(ms);
            await worker.tick();
          },
        }),
      },
    });
    const text = (
      await inRequest(() => tool(mcp.tools, 'fail').handle({}, caller(admin('u1'))))
    ).content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    // An uncoded throw is the framework's one name for "unexpected", as @ultimat3/http answers it.
    expect(JSON.parse(text)).toEqual({
      status: 'failed',
      jobId: expect.any(String),
      code: 'X_INTERNAL',
    });
    expect(text).not.toContain('hunter2');
  });

  test('a failed job crosses with the code it threw, never one its message only mentions', async () => {
    const answers: unknown[] = [];
    for (const thrown of [
      new UltimateError({ code: 'X_FORBIDDEN', cause: 'not yours', fix: 'x policy explain' }),
      new TypeError('X_FORBIDDEN looked up in a map that held nothing'),
    ]) {
      seq += 1;
      const failing = job({
        tenant: 'none',
        name: `coded${String(seq)}`,
        input: t.object({}),
        idempotencyKey: () => 'once',
        retry: { attempts: 1 },
        run: () => Promise.reject(thrown),
      });
      const worker = jobWorker({
        driver,
        clock,
        context: () => ctxOf({ role: 'worker' }),
        drainOnShutdown: false,
      });
      const mcp = defineAppMcp({
        tools: {
          fail: jobTool({
            job: failing,
            policy: 'catalog:admin',
            description: 'Fails.',
            result: report,
            wait: async (ms) => {
              clock.advance(ms);
              await worker.tick();
            },
          }),
        },
      });
      answers.push(
        json(await inRequest(() => tool(mcp.tools, 'fail').handle({}, caller(admin('u1'))))),
      );
    }
    expect(answers).toMatchObject([
      { status: 'failed', code: 'X_FORBIDDEN' },
      { status: 'failed', code: 'X_INTERNAL' },
    ]);
  });

  test('a failed job crosses with its declared callerFix — never the developer fix', async () => {
    seq += 1;
    const failing = job({
      tenant: 'none',
      name: `fixed${String(seq)}`,
      input: t.object({}),
      idempotencyKey: () => 'once',
      retry: { attempts: 1 },
      run: () =>
        Promise.reject(
          new UltimateError({
            code: 'X_FORBIDDEN',
            cause: 'not yours',
            fix: 'x policy explain catalog:admin',
            callerFix: 'ask an admin of this organisation for catalog access',
          }),
        ),
    });
    const worker = jobWorker({
      driver,
      clock,
      context: () => ctxOf({ role: 'worker' }),
      drainOnShutdown: false,
    });
    const mcp = defineAppMcp({
      tools: {
        fail: jobTool({
          job: failing,
          policy: 'catalog:admin',
          description: 'Fails.',
          result: report,
          wait: async (ms) => {
            clock.advance(ms);
            await worker.tick();
          },
        }),
      },
    });
    const answer = json(
      await inRequest(() => tool(mcp.tools, 'fail').handle({}, caller(admin('u1')))),
    );
    expect(answer).toEqual({
      status: 'failed',
      jobId: expect.any(String),
      code: 'X_FORBIDDEN',
      callerFix: 'ask an admin of this organisation for catalog access',
    });
    expect(JSON.stringify(answer)).not.toContain('x policy explain');
  });

  test('a clock that never moves still ends the wait: inlineMs is a count of polls too', async () => {
    seq += 1;
    const stuck = job({
      tenant: 'none',
      name: `stuck${String(seq)}`,
      input: t.object({}),
      idempotencyKey: () => 'stuck',
      retry: { attempts: 1 },
      async run() {},
    });
    let waits = 0;
    const mcp = defineAppMcp({
      tools: {
        stuck: jobTool({
          job: stuck,
          policy: 'catalog:admin',
          description: 'Stuck.',
          result: report,
          inlineMs: 1_000,
          // Waits without moving the clock, as a real wait under a frozen test clock does.
          wait: async () => {
            waits += 1;
          },
        }),
      },
    });
    const answer = json(
      await inRequest(() => tool(mcp.tools, 'stuck').handle({}, caller(admin('u1')))),
    );
    expect(answer).toMatchObject({ status: 'running' });
    expect(waits).toBe(4);
  });

  test('jobInput builds the job input from the tool input and the caller', async () => {
    seq += 1;
    const seen: unknown[] = [];
    const forMember = job({
      tenant: 'none',
      name: `member${String(seq)}`,
      input: t.object({ name: t.string, memberId: t.string }),
      idempotencyKey: (input: { name: string }) => input.name,
      retry: { attempts: 1 },
      async run({ input }) {
        seen.push(input);
      },
    });
    const worker = jobWorker({
      driver,
      clock,
      context: () => ctxOf({ role: 'worker' }),
      drainOnShutdown: false,
    });
    const mcp = defineAppMcp({
      tools: {
        member: jobTool({
          job: forMember,
          policy: 'catalog:admin',
          description: 'For the caller.',
          input: t.object({ name: t.string }),
          jobInput: (input, ctx) => ({ ...input, memberId: ctx.actor?.id ?? '' }),
          result: report,
          wait: async (ms) => {
            clock.advance(ms);
            await worker.tick();
          },
        }),
      },
    });
    const answer = json(
      await inRequest(() =>
        tool(mcp.tools, 'member').handle({ name: 'shop' }, caller(admin('u7'))),
      ),
    );
    expect(answer).toMatchObject({ status: 'done' });
    expect(seen).toEqual([{ name: 'shop', memberId: 'u7' }]);
  });

  test('an abort during the wait answers running and leaves the job queued', async () => {
    seq += 1;
    const slow = job({
      tenant: 'none',
      name: `slow${String(seq)}`,
      input: t.object({}),
      idempotencyKey: () => 'slow',
      retry: { attempts: 1 },
      async run() {
        finished.push('slow');
      },
    });
    const controller = new AbortController();
    const mcp = defineAppMcp({
      tools: {
        slow: jobTool({
          job: slow,
          policy: 'catalog:admin',
          description: 'Slow.',
          result: report,
          wait: async () => {
            controller.abort();
          },
        }),
      },
    });
    const answer = json(
      await runWithContext(ctxOf({ clock, signal: controller.signal }), () =>
        tool(mcp.tools, 'slow').handle({}, caller(admin('u1'))),
      ),
    ) as { status: string; jobId: string };
    expect(answer.status).toBe('running');
    expect((await driver.introspect?.job(answer.jobId))?.state).toBe('ready');
  });
});
