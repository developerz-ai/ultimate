// A stubbed job answers from its script through a REAL worker pass, records what it was handed, and
// is the declared body again in the next test — with no `afterEach` in this file doing it.

import { beforeAll, describe, expect } from 'bun:test';
import { InternalError, serviceActor } from '@ultimat3/core';
import { job, t } from '@ultimat3/jobs';
import { stub } from './stub';
import { endTestScope } from './test-scope';
import { unitTest } from './test-types';

const ran: string[] = [];
const welcome = job<{ readonly userId: string }>({
  name: 'stub-job-welcome',
  input: t.object({ userId: t.string }),
  tenant: 'none',
  idempotencyKey: (input) => input.userId,
  retry: { attempts: 1, jitter: false },
  run: async ({ input }) => {
    ran.push(input.userId);
    return { sent: input.userId };
  },
});

describe('stub(job)', () => {
  unitTest('the worker runs the script, not the body', async ({ runJobs }) => {
    const stubbed = await stub(welcome);
    stubbed.returns({ sent: 'stubbed' });
    const trace = await runJobs(welcome, { userId: 'u1' }, { actor: serviceActor({ id: 'ops' }) });
    expect(trace.executions[0]?.result).toEqual({ sent: 'stubbed' });
    expect(ran).toEqual([]);
    expect(stubbed.calls.map((call) => call.input)).toEqual([{ userId: 'u1' }]);
    expect(stubbed.calls[0]?.actor.id).toBe('ops');
  });

  unitTest('the next test runs the declared body again', async ({ runJobs }) => {
    const trace = await runJobs(welcome, { userId: 'u2' });
    expect(trace.executions[0]?.result).toEqual({ sent: 'u2' });
    expect(ran).toEqual(['u2']);
  });

  unitTest(
    'answers play in order, the last one repeated, and a throw is the run failing',
    async ({ runJobs }) => {
      const stubbed = await stub(welcome);
      stubbed.returns(1, 2).throws(new InternalError({ cause: 'stubbed refusal', fix: 'none' }));
      const answers = [];
      for (const userId of ['a', 'b', 'c', 'd']) {
        const trace = await runJobs(welcome, { userId });
        answers.push(trace.executions.at(-1)?.result ?? trace.executions.at(-1)?.error);
      }
      expect(answers.slice(0, 2)).toEqual([1, 2]);
      expect(String(answers[2])).toContain('stubbed');
      expect(String(answers[3])).toContain('stubbed');
    },
  );

  unitTest('a call before any answer is X_TEST_STUB_UNANSWERED', async ({ runJobs }) => {
    await stub(welcome);
    const trace = await runJobs(welcome, { userId: 'e' });
    expect(String(trace.executions[0]?.error)).toContain('X_TEST_STUB_UNANSWERED');
  });

  unitTest('a second stub replaces the first, and both are gone after the test', async () => {
    const first = await stub(welcome);
    first.returns('first');
    const second = await stub(welcome);
    second.returns('second');
    expect(first).not.toBe(second);
  });

  unitTest('a value that is no primitive is refused by name', async () => {
    await expect(stub({ name: 'look-alike' } as never)).rejects.toBeUltimateError(
      'X_TEST_STUB_TARGET_UNSUPPORTED',
    );
  });
});

describe('a scope that ends mid-stub', () => {
  unitTest('the late stub is undone as it lands', async ({ runJobs }) => {
    const pending = stub(welcome);
    endTestScope();
    (await pending).returns('late');
    const trace = await runJobs(welcome, { userId: 'late' });
    expect(trace.executions[0]?.result).toEqual({ sent: 'late' });
  });
});

// A file's stub and a test's stub on one target stack: the test's answers for its test, and the
// FILE's comes back after it — never the declared body, whose side effects the file stubbed away.
const layered = job<{ readonly userId: string }>({
  name: 'stub-job-layered',
  input: t.object({ userId: t.string }),
  tenant: 'none',
  idempotencyKey: (input) => input.userId,
  retry: { attempts: 1, jitter: false },
  run: async () => 'declared',
});

describe('a test stub over a file stub', () => {
  beforeAll(async () => {
    (await stub(layered)).returns('file');
  });

  unitTest('the file stub answers', async ({ runJobs }) => {
    expect((await runJobs(layered, { userId: 'a' })).executions[0]?.result).toBe('file');
  });

  unitTest('the test stub answers for its test', async ({ runJobs }) => {
    (await stub(layered)).returns('test');
    expect((await runJobs(layered, { userId: 'b' })).executions[0]?.result).toBe('test');
  });

  unitTest('the file stub answers again', async ({ runJobs }) => {
    expect((await runJobs(layered, { userId: 'c' })).executions[0]?.result).toBe('file');
  });
});
