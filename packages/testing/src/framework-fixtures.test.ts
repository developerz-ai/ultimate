import { afterEach, test as bunTest, describe, expect } from 'bun:test';
import { assert } from '@ultimat3/core';
import type { JobDefinition, JobHandle } from '@ultimat3/jobs';
import { job, jobDriver, resetJobDriver } from '@ultimat3/jobs';
import { mailDriver, resetMailDriver, tryMailDriver } from '@ultimat3/mail';
import { frozenNow, setFrozenClock } from './determinism';
import { testJobs } from './fixture-jobs';
import { testMail } from './fixture-mail';
import { testPush } from './fixture-push';
import { fixtureTest, registeredFixtures } from './fixtures';
import {
  ALL_FIXTURE_NAMES,
  FRAMEWORK_FIXTURE_NAMES,
  registerFrameworkFixtures,
} from './framework-fixtures';
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
  bunTest('builds exactly clock, mail, network, push, runJobs, statements and subscribe', () => {
    registerFrameworkFixtures();
    // `subscribe` joined this list on 2026-08-20. It was declared-and-driverless because the
    // framework had no change SOURCE in a test process — PGlite has no walsender and the memory
    // driver no log — and `@ultimat3/entity`'s `setRowObserver` is that source, so the framework
    // can now build a whole in-process `sync` node for it.
    expect([...FRAMEWORK_FIXTURE_NAMES]).toEqual([
      'clock',
      'mail',
      'network',
      'push',
      'runJobs',
      'statements',
      'subscribe',
    ]);
  });

  // The bag is the contract: a name the reference app destructures and the framework never
  // registers fails as X_TEST_FIXTURE_UNKNOWN, whose fix tells the app to invent its own `page`.
  bunTest('registers every name it declares, driver-backed ones included', () => {
    registerFrameworkFixtures();
    expect(registeredFixtures()).toEqual(expect.arrayContaining([...ALL_FIXTURE_NAMES]));
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
    const mail = await testMail();
    mail.failOnce('welcome');

    await expect(mailDriver().send(message('welcome'))).rejects.toBeUltimateError(
      'X_MAIL_DRIVER_UNAVAILABLE',
    );
    await mailDriver().send(message('welcome'));
    await mailDriver().send(message('invite'));

    expect(mail.outbox().map((entry) => entry.message.mailId)).toEqual(['invite', 'welcome']);
  });

  bunTest('failOnce takes a mail definition, not only an id', async () => {
    const mail = await testMail();
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
      // A fixture asserting retry and step replay — it reads no tenant-scoped table.
      tenant: 'none',
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
    const runJobs = await testJobs();

    await runJobs(handle, { id: 'a' });
    setFrozenClock(frozenNow().getTime() + 2_000);
    const trace = await runJobs.drain();

    expect(trace.steps['provision']?.executions).toBe(1);
    expect(trace.steps['nudge']?.executions).toBe(2);
    expect(await runJobs.depth()).toBe(0);
  });

  bunTest('a duplicate enqueue with a live key returns the same job', async () => {
    const handle = flakyJob('fixture-dedupe', () => false);
    const runJobs = await testJobs();

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
      tenant: 'none',
      idempotencyKey: (input) => `sleeper:${input.id}`,
      retry: { attempts: 1 },
      run: async ({ step }) => {
        await step.sleep('3d');
      },
    });
    const runJobs = await testJobs();

    await runJobs(sleeper, { id: 'c' });
    expect(await runJobs.inFlight()).toBe(0);
    expect(await runJobs.due()).toBe(0);

    setFrozenClock(frozenNow().getTime() + 3 * DAY_MS);
    expect(await runJobs.due()).toBe(1);
  });

  bunTest('each build gets its own queue, so one test cannot see another test’s jobs', async () => {
    const handle = flakyJob('fixture-isolated', () => false);
    const first = await testJobs();
    await first.enqueue(handle, { id: 'e' });

    const second = await testJobs();

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
    const runJobs = await testJobs();
    expect(jobDriver()).toBeDefined();

    await runJobs[Symbol.asyncDispose]();

    expect(jobDriver()).toBeUndefined();
  });

  bunTest('and restores an outer driver rather than clearing it', async () => {
    const outer = await testJobs();
    const outerDriver = jobDriver();
    const inner = await testJobs();
    expect(jobDriver()).not.toBe(outerDriver);

    await inner[Symbol.asyncDispose]();

    expect(jobDriver()).toBe(outerDriver);
    await outer[Symbol.asyncDispose]();
  });

  bunTest('the mail fixture restores the ambient mail driver too', async () => {
    resetMailDriver();
    const mail = await testMail();
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

describe(testName('unit', 'the push fixture'), () => {
  bunTest('a subscribed person receives the notification their device would show', async () => {
    const { pushToActor } = await import('@ultimat3/pwa');
    using push = await testPush();
    await push.subscribe('ana', { locale: 'en' });
    await push.subscribe('ben');
    const report = await pushToActor('ana', {
      titleKey: 'push.missing.title',
      bodyKey: 'push.missing.body',
      url: '/posts/1',
      tag: 'post:1',
      urgency: 'high',
    });
    expect(report).toEqual({ delivered: 1, removed: 0, refused: 0 });
    const [message] = push.sent();
    expect(message?.actorId).toBe('ana');
    expect(message?.headers['urgency']).toBe('high');
    // Decrypted with ana's own browser key: the fields the worker shows, keys rendered (here, the
    // loud miss — this test registers no catalog).
    expect(message?.notification).toMatchObject({
      title: '⟦push.missing.title⟧',
      url: '/posts/1',
      tag: 'post:1',
      lang: 'en',
    });
  });

  bunTest(
    'the runtime reads the frozen clock the `clock` fixture moves, never the wall clock',
    async () => {
      const { webPushRuntime } = await import('@ultimat3/pwa');
      using _push = await testPush();
      const runtime = webPushRuntime('the push fixture test');
      const before = runtime.clock.monotonic();
      setFrozenClock(frozenNow().getTime() + 172_800_000);
      try {
        expect(runtime.clock.monotonic() - before).toBe(172_800_000);
        expect(runtime.clock.now().getTime()).toBe(frozenNow().getTime());
      } finally {
        setFrozenClock(frozenNow().getTime() - 172_800_000);
      }
    },
  );

  bunTest('answerOnce(410) deletes the device; a 429 is the job retrying', async () => {
    const { pushToActor } = await import('@ultimat3/pwa');
    using push = await testPush();
    await push.subscribe('ana');
    push.answerOnce(410);
    expect(await pushToActor('ana', { titleKey: 'a', bodyKey: 'b', url: '/' })).toEqual({
      delivered: 0,
      removed: 1,
      refused: 0,
    });
    await push.subscribe('ana');
    push.answerOnce(429);
    await expect(
      pushToActor('ana', { titleKey: 'a', bodyKey: 'b', url: '/' }),
    ).rejects.toMatchObject({ code: 'X_PWA_PUSH_FAILED' });
    expect(push.sent()).toEqual([]);
  });

  bunTest(
    'disposing releases the runtime: push outside the test is unconfigured again',
    async () => {
      const { pushToActor } = await import('@ultimat3/pwa');
      {
        using push = await testPush();
        await push.subscribe('ana');
      }
      await expect(
        pushToActor('ana', { titleKey: 'a', bodyKey: 'b', url: '/' }),
      ).rejects.toMatchObject({ code: 'X_PWA_PUSH_UNCONFIGURED' });
    },
  );
});
