import { afterEach, test as bunTest, describe, expect } from 'bun:test';
import { assert } from '@ultimat3/core';
import type { JobDefinition, JobHandle } from '@ultimat3/jobs';
import { job, jobDriver, resetJobDriver } from '@ultimat3/jobs';
import { mailDriver, resetMailDriver, tryMailDriver } from '@ultimat3/mail';
import { frozenNow, setFrozenClock } from './determinism';
import { createRunJobs } from './fixture-jobs';
import { createTestMail } from './fixture-mail';
import { fixtureTest } from './fixtures';
import { FRAMEWORK_FIXTURE_NAMES, registerFrameworkFixtures } from './framework-fixtures';
import { testName } from './test-types';

// Every global these fixtures touch is process-wide and bun shares one process across files.
// The tests below build fixtures by hand rather than through `fixtureTest`, so nothing disposes
// them for us — the ambient job driver in particular, which turns a later `send()` into an
// enqueue against this file's dead queue.
const START = frozenNow().toISOString();
afterEach(() => {
  setFrozenClock(START);
  resetMailDriver();
  resetJobDriver();
});

const DAY_MS = 24 * 60 * 60 * 1_000;

const passthrough = <T>(): JobDefinition<T>['input'] => ({
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value: unknown) => ({ value: value as T }),
  },
});

const message = (mailId: string) => ({
  mailId,
  to: ['ada@acme.example'],
  subject: 'mail.welcome.subject',
  html: '<p>hi</p>',
  text: 'hi',
  locale: 'en',
  tz: 'UTC',
});

describe(testName('unit', 'the framework fixture bag'), () => {
  bunTest('owns exactly clock, mail and runJobs', () => {
    registerFrameworkFixtures();
    expect([...FRAMEWORK_FIXTURE_NAMES]).toEqual(['clock', 'mail', 'runJobs']);
  });

  // The regression the registration exists for: before it, every body destructuring `clock`
  // died with X_TEST_FIXTURE_UNKNOWN because nothing in the repo called defineFixtures.
  fixtureTest('injects `clock` into a body that destructures it', ({ clock }) => {
    expect(clock.now().toISOString()).toBe(frozenNow().toISOString());
  });

  fixtureTest('clock.advance moves the frozen clock by a duration string', ({ clock }) => {
    const before = clock.now().getTime();
    clock.advance('1h');
    expect(clock.now().getTime() - before).toBe(3_600_000);
    // The whole point of advancing rather than waiting: `Date.now()` moves with it.
    expect(Date.now()).toBe(clock.now().getTime());
  });
});

describe(testName('unit', 'the mail fixture'), () => {
  bunTest('failOnce rejects the next send of that mail and only that one', async () => {
    const mail = await createTestMail();
    mail.failOnce('welcome');

    await expect(mailDriver().send(message('welcome'))).rejects.toBeUltimateError(
      'X_MAIL_DRIVER_UNAVAILABLE',
    );
    await mailDriver().send(message('welcome'));
    await mailDriver().send(message('invite'));

    expect(mail.outbox().map((entry) => entry.message.mailId)).toEqual(['invite', 'welcome']);
  });

  bunTest('failOnce takes a mail definition, not only an id', async () => {
    const mail = await createTestMail();
    mail.failOnce({ id: 'invite' });

    await expect(mailDriver().send(message('invite'))).rejects.toBeUltimateError();
    expect(mail.outbox()).toEqual([]);
  });
});

describe(testName('unit', 'the runJobs fixture'), () => {
  const flakyJob = (name: string, fails: () => boolean): JobHandle<{ readonly id: string }> =>
    job<{ readonly id: string }>({
      name,
      input: passthrough<{ readonly id: string }>(),
      idempotencyKey: (input) => `${name}:${input.id}`,
      retry: { attempts: 3, backoff: 'fixed', delay: 1_000, jitter: false },
      run: async ({ step }) => {
        await step.run('provision', () => 'provisioned');
        await step.run('nudge', () => {
          assert(!fails(), 'nudge failed on purpose', 'nothing — this is a fixture');
          return 'nudged';
        });
      },
    });

  bunTest('retries only the failed step — the earlier one replays from storage', async () => {
    let nudges = 0;
    const handle = flakyJob('fixture-retry', () => {
      nudges += 1;
      return nudges === 1;
    });
    const runJobs = await createRunJobs();

    await runJobs(handle, { id: 'a' });
    setFrozenClock(frozenNow().getTime() + 2_000);
    const trace = await runJobs.drain();

    expect(trace.steps['provision']?.executions).toBe(1);
    expect(trace.steps['nudge']?.executions).toBe(2);
    expect(await runJobs.depth()).toBe(0);
  });

  bunTest('a duplicate enqueue with a live key returns the same job', async () => {
    const handle = flakyJob('fixture-dedupe', () => false);
    const runJobs = await createRunJobs();

    const first = await runJobs.enqueue(handle, { id: 'b' });
    const second = await runJobs.enqueue(handle, { id: 'b' });

    expect(second.id).toBe(first.id);
    expect(second.deduped).toBe(true);
    expect(await runJobs.depth(handle)).toBe(1);
  });

  bunTest('a sleeping step parks the run instead of holding a worker', async () => {
    const sleeper = job<{ readonly id: string }>({
      name: 'fixture-sleeper',
      input: passthrough<{ readonly id: string }>(),
      idempotencyKey: (input) => `sleeper:${input.id}`,
      retry: { attempts: 1 },
      run: async ({ step }) => {
        await step.sleep('3d');
      },
    });
    const runJobs = await createRunJobs();

    await runJobs(sleeper, { id: 'c' });
    expect(await runJobs.inFlight()).toBe(0);
    expect(await runJobs.due()).toBe(0);

    setFrozenClock(frozenNow().getTime() + 3 * DAY_MS);
    expect(await runJobs.due()).toBe(1);
  });

  bunTest('each build gets its own queue, so one test cannot see another test’s jobs', async () => {
    const handle = flakyJob('fixture-isolated', () => false);
    const first = await createRunJobs();
    await first.enqueue(handle, { id: 'e' });

    const second = await createRunJobs();

    expect(await first.depth()).toBe(1);
    expect(await second.depth()).toBe(0);
  });
});

// The regression: `runJobs` used to install the ambient job driver and leave it there. Nothing
// in this file noticed — but `send()` enqueues whenever a queue is ambient, so every mail test
// in a later file asserted on the inline path and got `driver: 'queue'` instead.
describe(testName('unit', 'a fixture that installs process-global state hands it back'), () => {
  bunTest('runJobs restores the driver the process had before it', async () => {
    resetJobDriver();
    const runJobs = await createRunJobs();
    expect(jobDriver()).toBeDefined();

    await runJobs[Symbol.asyncDispose]();

    expect(jobDriver()).toBeUndefined();
  });

  bunTest('and restores an outer driver rather than clearing it', async () => {
    const outer = await createRunJobs();
    const outerDriver = jobDriver();
    const inner = await createRunJobs();
    expect(jobDriver()).not.toBe(outerDriver);

    await inner[Symbol.asyncDispose]();

    expect(jobDriver()).toBe(outerDriver);
    await outer[Symbol.asyncDispose]();
  });

  bunTest('the mail fixture restores the ambient mail driver too', async () => {
    resetMailDriver();
    const mail = await createTestMail();
    expect(tryMailDriver()?.name).toBe('test');

    mail[Symbol.dispose]();

    expect(tryMailDriver()).toBeUndefined();
  });

  // Teardown is what the leak fix rides on, so it has to survive the failing test it follows.
  fixtureTest('disposal runs even when the body throws', async ({ runJobs }) => {
    expect(runJobs).toBeDefined();
    await expect(Promise.reject(new Error('boom'))).rejects.toThrow('boom');
  });

  bunTest('so the next test starts without the previous one’s queue', () => {
    expect(jobDriver()).toBeUndefined();
  });
});
