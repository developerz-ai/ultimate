import { describe, expect, test } from 'bun:test';
import { exec } from './exec';
import {
  CHECK_STEP_TIMEOUT_MS,
  guardStep,
  killTagged,
  psProcesses,
  raceDeadline,
  readStepTimeouts,
  STEP_TAG_ENV,
  SUITE_STEP_TIMEOUT_MS,
  stepTimeoutMs,
  taggedPids,
} from './verify-deadline';
import { VERIFY_STEP_NAMES } from './verify-step';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A killed child is a zombie until its parent reaps it; give the reaper a moment. */
const goneSoon = async (pids: readonly number[]): Promise<boolean> => {
  for (let i = 0; i < 100; i += 1) {
    if (pids.every((pid) => !alive(pid))) return true;
    await Bun.sleep(20);
  }
  return false;
};

describe('the deadline a step runs under', () => {
  test('a suite gets the suite number, a check the check number', () => {
    expect(stepTimeoutMs('unit')).toBe(SUITE_STEP_TIMEOUT_MS);
    expect(stepTimeoutMs('e2e')).toBe(SUITE_STEP_TIMEOUT_MS);
    expect(stepTimeoutMs('lint')).toBe(CHECK_STEP_TIMEOUT_MS);
    expect(stepTimeoutMs('manifest')).toBe(CHECK_STEP_TIMEOUT_MS);
  });

  test('the first table that names the step wins, and one that does not is passed over', () => {
    expect(stepTimeoutMs('unit', { unit: 50 }, { unit: 900 })).toBe(50);
    expect(stepTimeoutMs('unit', undefined, { unit: 900 })).toBe(900);
    expect(stepTimeoutMs('unit', { lint: 7 }, undefined)).toBe(SUITE_STEP_TIMEOUT_MS);
  });

  test('x.verify.json: a whole positive number per declared step, anything else refused', () => {
    expect(readStepTimeouts({ stepTimeoutMs: { unit: 900_000 } }, VERIFY_STEP_NAMES)).toEqual({
      timeouts: { unit: 900_000 },
      problems: [],
    });
    expect(readStepTimeouts({}, VERIFY_STEP_NAMES)).toEqual({ problems: [] });
    const bad = readStepTimeouts(
      { stepTimeoutMs: { unit: '15m', units: 5, lint: 0, e2e: 1.5 } },
      VERIFY_STEP_NAMES,
    );
    expect(bad.timeouts).toBeUndefined();
    expect(bad.problems).toHaveLength(4);
    expect(bad.problems.join('\n')).toContain('names units, which x verify does not run');
    expect(readStepTimeouts({ stepTimeoutMs: 5 }, VERIFY_STEP_NAMES).problems).toHaveLength(1);
  });
});

describe('raceDeadline', () => {
  test('work that finishes in time is its own value', async () => {
    expect(await raceDeadline(Promise.resolve(7), 1_000)).toEqual({ timedOut: false, value: 7 });
  });

  test('work that does not is timedOut, and its later rejection is not unhandled', async () => {
    let fail: (reason: unknown) => void = () => undefined;
    const never = new Promise<number>((_resolve, reject) => {
      fail = reject;
    });
    expect(await raceDeadline(never, 10)).toEqual({ timedOut: true });
    fail(new TypeError('late'));
    await Bun.sleep(1);
  });
});

describe('which processes carry a tag', () => {
  test('a NUL-separated environ, a tag among several, and a near miss', () => {
    const processes = [
      { pid: 10, environ: `PATH=/bin\0${STEP_TAG_ENV}=unit@a\0HOME=/h` },
      { pid: 11, environ: `${STEP_TAG_ENV}=live@z unit@a\0` },
      { pid: 12, environ: `${STEP_TAG_ENV}=unit@ab\0` },
      { pid: 13, environ: 'PATH=/bin\0' },
    ];
    expect(taggedPids(processes, 'unit@a')).toEqual([10, 11]);
  });

  test('a `ps -E` line: space-separated pairs after the command', () => {
    const processes = [
      { pid: 20, environ: `bun test a.test.ts PATH=/bin ${STEP_TAG_ENV}=live@z unit@a HOME=/h` },
      { pid: 21, environ: `sleep 30 ${STEP_TAG_ENV}=other@a HOME=/h` },
    ];
    expect(taggedPids(processes, 'unit@a')).toEqual([20]);
  });
});

describe('guardStep', () => {
  test('expire() kills the child AND the grandchild it left behind, and starts nothing after', async () => {
    const tag = `test@${crypto.randomUUID()}`;
    const guard = guardStep(exec, tag, {});
    // The shell backgrounds one sleeper and waits on another: two processes, one of which is
    // re-parented the moment the shell dies — the orphan a ppid walk would miss.
    const running = guard.runner(['sh', '-c', 'sleep 300 & echo $! ; echo $$ ; sleep 300'], {
      cwd: process.cwd(),
    });
    let listed: readonly number[] = [];
    for (let i = 0; i < 100 && listed.length < 3; i += 1) {
      await Bun.sleep(20);
      listed = await tagged(tag);
    }
    expect(listed.length).toBeGreaterThanOrEqual(3);
    const expiry = await guard.expire();
    expect(expiry.killed.length).toBeGreaterThanOrEqual(3);
    // Read before the kill, so each is still its own argv and not an empty zombie.
    const commands = expiry.killed.map((one) => one.command);
    expect(commands.filter((command) => command === 'sleep 300')).toHaveLength(2);
    expect(commands.some((command) => command.startsWith('sh -c sleep 300 &'))).toBe(true);
    // The call the step was waiting on, with what the child had printed before it died.
    expect(expiry.inFlight).toHaveLength(1);
    expect(expiry.inFlight[0]?.command[0]).toBe('sh');
    expect(expiry.inFlight[0]?.output?.split('\n')).toHaveLength(2);
    const result = await running;
    expect(result.ok).toBe(false);
    expect(await goneSoon(listed)).toBe(true);
    const after = await guard.runner(['sh', '-c', 'echo started'], { cwd: process.cwd() });
    expect(after.ok).toBe(false);
    expect(after.stdout).toBe('');
    expect(after.stderr).toContain('past its deadline');
  });

  test('a nested gate appends to the tag it inherited, so the outer kill still finds its children', async () => {
    const outer = `outer@${crypto.randomUUID()}`;
    const inner = `inner@${crypto.randomUUID()}`;
    const guard = guardStep(exec, inner, { [STEP_TAG_ENV]: outer });
    const running = guard.runner(['sleep', '300'], { cwd: process.cwd() });
    let listed: readonly number[] = [];
    for (let i = 0; i < 100 && listed.length < 1; i += 1) {
      await Bun.sleep(20);
      listed = await tagged(outer);
    }
    expect(listed).toHaveLength(1);
    expect(await killTagged(outer)).toEqual([{ pid: listed[0] as number, command: 'sleep 300' }]);
    expect((await running).ok).toBe(false);
  });
});

describe('where there is no procfs', () => {
  test('ps lists the tagged child with its environment, and the kill works off that list', async () => {
    const tag = `ps@${crypto.randomUUID()}`;
    const guard = guardStep(exec, tag, {});
    const running = guard.runner(['sleep', '300'], { cwd: process.cwd() });
    let found: readonly number[] = [];
    for (let i = 0; i < 100 && found.length < 1; i += 1) {
      await Bun.sleep(20);
      found = taggedPids(await psProcesses(), tag);
    }
    expect(found).toHaveLength(1);
    expect(await killTagged(tag, psProcesses)).toHaveLength(1);
    expect((await running).ok).toBe(false);
    expect(await goneSoon(found)).toBe(true);
  });

  test('a ps that outlives its timeout is KILLED, and its partial listing is never an answer', async () => {
    // Ignores SIGTERM and has already printed one tagged-looking line: a timeout that only sent
    // SIGTERM waited out the sleep, and a listing cut short read as "nothing left to kill".
    const stubborn = ['sh', '-c', 'trap "" TERM; echo "4242 X_TAG=1"; exec sleep 30'];
    const started = performance.now();
    expect(await psProcesses(stubborn, 200)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test('a process table that cannot be read kills nothing and does not throw', async () => {
    expect(await killTagged('nothing@carries-this', async () => [])).toEqual([]);
  });
});

/** The live processes carrying `tag`, read the way `killTagged` reads them on this platform. */
async function tagged(tag: string): Promise<readonly number[]> {
  const pids: number[] = [];
  for await (const entry of new Bun.Glob('[0-9]*').scan({ cwd: '/proc', onlyFiles: false })) {
    const environ = await Bun.file(`/proc/${entry}/environ`)
      .text()
      .catch(() => '');
    if (taggedPids([{ pid: Number(entry), environ }], tag).length > 0) pids.push(Number(entry));
  }
  return pids;
}
