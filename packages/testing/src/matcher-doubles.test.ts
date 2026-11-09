// The assertions on test doubles, each with the case that must FAIL: a call, an enqueue and a mail
// that did not happen are red, a wrong receiver is a coded throw, and an expected input the
// primitive's own schema refuses is `X_TEST_EXPECTED_INPUT_INVALID` — never a plain "not called".

import { describe, expect, mock } from 'bun:test';
import { job, t } from '@ultimat3/jobs';
import { toHaveEnqueued } from './matcher-doubles';
import { stub } from './stub';
import { unitTest } from './test-types';

const nudge = job<{ readonly userId: string; readonly times: number }>({
  name: 'matcher-doubles-nudge',
  input: t.object({ userId: t.string, times: t.number }),
  tenant: 'none',
  idempotencyKey: (input) => `${input.userId}:${String(input.times)}`,
  retry: { attempts: 1, jitter: false },
  run: async () => 'ran',
});

describe('toHaveBeenCalledWith on a stub', () => {
  unitTest(
    'passes for an input it was called with, fails for one it was not',
    async ({ runJobs }) => {
      const stubbed = await stub(nudge);
      stubbed.returns('stubbed');
      await runJobs(nudge, { userId: 'u1', times: 1 });
      expect(stubbed).toHaveBeenCalledWith({ userId: 'u1', times: 1 });
      expect(stubbed).not.toHaveBeenCalledWith({ userId: 'u2', times: 1 });
      expect(() => expect(stubbed).toHaveBeenCalledWith({ userId: 'u2', times: 1 })).toThrow(
        /to have been called with .*its 1 call/,
      );
      expect(() => expect(stubbed).not.toHaveBeenCalledWith({ userId: 'u1', times: 1 })).toThrow(
        /not to have been called with/,
      );
    },
  );

  unitTest('an expected input the schema refuses is a coded refusal', async () => {
    const stubbed = await stub(nudge);
    expect(() => expect(stubbed).toHaveBeenCalledWith({ userId: 'u1', times: 'one' })).toThrow(
      expect.objectContaining({ code: 'X_TEST_EXPECTED_INPUT_INVALID' }),
    );
  });

  unitTest("a bun mock still gets bun's own matcher, both ways", () => {
    const spy = mock((_n: number) => 1);
    spy(2);
    expect(spy).toHaveBeenCalledWith(2);
    expect(spy).not.toHaveBeenCalledWith(3);
    expect(() => expect(spy).toHaveBeenCalledWith(3)).toThrow();
    expect(() => expect(spy).not.toHaveBeenCalledWith(2)).toThrow();
  });
});

describe('toHaveEnqueued', () => {
  unitTest('a row for the job with that input passes; another input fails', async ({ runJobs }) => {
    await runJobs.enqueue(nudge, { userId: 'u1', times: 2 });
    await expect(runJobs).toHaveEnqueued(nudge);
    await expect(runJobs).toHaveEnqueued(nudge, { userId: 'u1', times: 2 });
    await expect(runJobs).not.toHaveEnqueued(nudge, { userId: 'u1', times: 3 });
    // An async matcher's red is reported by bun, not rejected, so the verdict is read directly.
    const red = await toHaveEnqueued(runJobs, nudge, { userId: 'u9', times: 2 });
    expect(red.pass).toBe(false);
    expect(red.message()).toMatch(/to have been enqueued with .*the queue holds 1/);
  });

  unitTest('a run row still counts as enqueued; an empty queue fails', async ({ runJobs }) => {
    await expect(runJobs).not.toHaveEnqueued(nudge);
    expect((await toHaveEnqueued(runJobs, nudge)).message()).toMatch(/the queue holds 0/);
    await runJobs(nudge, { userId: 'u1', times: 1 });
    await expect(runJobs).toHaveEnqueued(nudge, { userId: 'u1', times: 1 });
    const green = await toHaveEnqueued(runJobs, nudge);
    expect(green.pass).toBe(true);
    expect(green.message()).toMatch(/not to have been enqueued/);
  });

  unitTest('a wrong receiver and a refused input are coded throws', async ({ runJobs }) => {
    expect(() => expect({}).toHaveEnqueued(nudge)).toThrow(
      expect.objectContaining({ code: 'X_TEST_RUN_JOBS_EXPECTED' }),
    );
    expect(() => expect(runJobs).toHaveEnqueued(nudge, { userId: 1 } as never)).toThrow(
      expect.objectContaining({ code: 'X_TEST_EXPECTED_INPUT_INVALID' }),
    );
  });
});

describe('toHaveSentMail', () => {
  const sent = {
    outbox: () => [{ message: { mailId: 'welcome', to: ['ada@example.test'] } }],
  };

  unitTest('the mail, to the address, passes; another mail or address fails', () => {
    expect(sent).toHaveSentMail('welcome');
    expect(sent).toHaveSentMail({ id: 'welcome' }, { to: 'ada@example.test' });
    expect(sent).not.toHaveSentMail('welcome', { to: 'bob@example.test' });
    expect(sent).not.toHaveSentMail('reset');
    expect(() => expect(sent).toHaveSentMail('reset')).toThrow(/the outbox holds .*welcome/);
    expect(() => expect(sent).not.toHaveSentMail('welcome')).toThrow(/not to have been sent/);
  });

  unitTest('reads the real mail fixture', async ({ mail }) => {
    expect(mail).not.toHaveSentMail('welcome');
  });

  unitTest('a wrong receiver is a coded throw', () => {
    expect(() => expect([]).toHaveSentMail('welcome')).toThrow(
      expect.objectContaining({ code: 'X_TEST_MAIL_EXPECTED' }),
    );
  });
});
