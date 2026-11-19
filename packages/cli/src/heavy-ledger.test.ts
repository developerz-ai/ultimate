// The ledger's guarantees are the kernel's, so these run real processes on real files: a fake flock
// would prove only the fake. Every wait is on a line a child printed, never on a guessed delay.

import { afterEach, describe, expect, test } from 'bun:test';
// why: temp directories and an append-only event log; Bun ships neither primitive.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
// why: the test's scratch root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { flockBinding } from './heavy-flock';
import { readLedger, unitsThatFit } from './heavy-ledger';

// flock(2) does not exist on Windows, where admission is off (`heavy-flock.ts`).
const NO_FLOCK = process.platform === 'win32';
const FLOCK = join(import.meta.dir, 'heavy-flock.ts');
const LEDGER = join(import.meta.dir, 'heavy-ledger.ts');
const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'heavy-ledger-'));
  dirs.push(dir);
  return dir;
};
const started: { kill(signal: 'SIGKILL'): void }[] = [];
afterEach(() => {
  // A failed assertion must not leave a holder waiting forever behind the run's own pipes.
  for (const child of started.splice(0)) child.kill('SIGKILL');
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tryLock = async () => {
  const binding = await flockBinding();
  if (!binding.ok) expect.unreachable(binding.reason);
  return binding.tryLock;
};

interface ChildPlan {
  readonly dir: string;
  readonly capacityMb: number;
  readonly mb: number;
  readonly label: string;
  /** Runs once admitted, as source text; the child then prints `held` and awaits it. */
  readonly body?: string;
}

function reserver(plan: ChildPlan) {
  const source = `
    import { flockBinding } from ${JSON.stringify(FLOCK)};
    import { reserve } from ${JSON.stringify(LEDGER)};
    import { appendFileSync } from 'node:fs';
    const { tryLock } = await flockBinding();
    const log = (line) => appendFileSync(${JSON.stringify(join(plan.dir, 'events'))}, line + '\\n');
    console.log('joining');
    const held = await reserve({ dir: ${JSON.stringify(plan.dir)}, capacityMb: ${plan.capacityMb},
      unitMb: ${plan.mb}, units: 1, label: ${JSON.stringify(plan.label)}, cwd: '/w', tryLock,
      pollMs: 5, onWait: () => console.log('waiting') });
    log('+ ${plan.mb} ${plan.label}');
    console.log('held');
    ${plan.body ?? 'await new Promise(() => {});'}
    log('- ${plan.mb} ${plan.label}');
    held.release();
    process.exit(0);`;
  const child = Bun.spawn(['bun', '-e', source], { stdout: 'pipe', stderr: 'inherit' });
  started.push(child);
  const reader = child.stdout.getReader();
  let seen = '';
  const until = async (word: string): Promise<void> => {
    while (!seen.includes(word)) {
      const { value, done } = await reader.read();
      if (done) expect.unreachable(`the child exited before printing ${word}: ${seen}`);
      seen += new TextDecoder().decode(value);
    }
  };
  const untilAny = async (words: readonly string[]): Promise<string> => {
    for (;;) {
      const found = words.find((word) => seen.includes(word));
      if (found !== undefined) return found;
      const { value, done } = await reader.read();
      if (done) expect.unreachable(`the child exited before printing any of ${words.join()}`);
      seen += new TextDecoder().decode(value);
    }
  };
  return { child, until, untilAny, output: () => seen };
}

const events = (dir: string): string[] =>
  readFileSync(join(dir, 'events'), 'utf8').trim().split('\n');

describe.skipIf(NO_FLOCK)('reserve', () => {
  test('concurrent processes never sum past the capacity', async () => {
    const dir = scratch();
    const go = join(dir, 'go');
    // Every holder stays until all twelve have either been admitted or queued, so an admission
    // past the capacity cannot hide behind holders that happened to finish first.
    const children = Array.from({ length: 12 }, (_, at) =>
      reserver({
        dir,
        capacityMb: 100,
        mb: 40,
        label: `c${String(at)}`,
        body: `while (!(await Bun.file(${JSON.stringify(go)}).exists())) await Bun.sleep(5);`,
      }),
    );
    const said = await Promise.all(children.map((one) => one.untilAny(['held', 'waiting'])));
    expect(said.filter((word) => word === 'held')).toHaveLength(2);
    await Bun.write(go, '');
    await Promise.all(children.map((one) => one.child.exited));
    let used = 0;
    let peak = 0;
    for (const line of events(dir)) {
      used += line.startsWith('+') ? 40 : -40;
      peak = Math.max(peak, used);
    }
    expect(events(dir)).toHaveLength(24);
    expect(peak).toBe(80);
    expect(readdirSync(join(dir, 'holds'))).toEqual([]);
  }, 60_000);

  test('kill -9 of a holder frees its share at once, with its file still on disk', async () => {
    const dir = scratch();
    const holder = reserver({ dir, capacityMb: 10, mb: 10, label: 'holder' });
    await holder.until('held');
    const waiter = reserver({ dir, capacityMb: 10, mb: 10, label: 'waiter', body: '' });
    await waiter.until('waiting');
    holder.child.kill('SIGKILL');
    expect(await waiter.child.exited).toBe(0);
    expect(events(dir)).toEqual(['+ 10 holder', '+ 10 waiter', '- 10 waiter']);
  }, 30_000);

  test('kill -9 of the waiter at the head lets the one behind it through', async () => {
    const dir = scratch();
    const holder = reserver({ dir, capacityMb: 10, mb: 10, label: 'holder' });
    await holder.until('held');
    const head = reserver({ dir, capacityMb: 10, mb: 10, label: 'head' });
    await head.until('waiting');
    const next = reserver({ dir, capacityMb: 10, mb: 10, label: 'next', body: '' });
    await next.until('waiting');
    head.child.kill('SIGKILL');
    await head.child.exited;
    holder.child.kill('SIGKILL');
    expect(await next.child.exited).toBe(0);
    expect(events(dir)).not.toContain('+ 10 head');
  }, 30_000);

  test('first come, first served: a small request does not pass a big one', async () => {
    const dir = scratch();
    const holder = reserver({ dir, capacityMb: 100, mb: 60, label: 'holder' });
    await holder.until('held');
    const big = reserver({ dir, capacityMb: 100, mb: 80, label: 'big', body: '' });
    await big.until('waiting');
    // 30 MB fits beside the holder right now; only the queue keeps it behind `big`.
    const small = reserver({ dir, capacityMb: 100, mb: 30, label: 'small', body: '' });
    await small.until('waiting');
    expect(events(dir)).toEqual(['+ 60 holder']);
    holder.child.kill('SIGKILL');
    await Promise.all([big.child.exited, small.child.exited]);
    expect(events(dir).slice(1, 3)).toEqual(['+ 80 big', '- 80 big']);
    expect(events(dir)[3]).toBe('+ 30 small');
  }, 30_000);

  test('a child of the holder does not keep its lock alive', async () => {
    const dir = scratch();
    const holder = reserver({
      dir,
      capacityMb: 10,
      mb: 10,
      label: 'holder',
      body: `const kid = Bun.spawn(['sleep', '30'], { stdio: ['ignore', 'ignore', 'ignore'] });
             console.log('kid ' + kid.pid + ' .'); await new Promise(() => {});`,
    });
    await holder.until(' .');
    holder.child.kill('SIGKILL');
    await holder.child.exited;
    expect(readLedger(dir, await tryLock()).holds).toEqual([]);
  }, 30_000);

  test('a child handed the locked descriptor keeps the reservation after kill -9', async () => {
    const dir = scratch();
    const holder = reserver({
      dir,
      capacityMb: 10,
      mb: 10,
      label: 'holder',
      body: `const kid = Bun.spawn(['sleep', '30'], {
               stdio: ['ignore', 'ignore', 'ignore', held.fd] });
             console.log('kid ' + kid.pid + ' .'); await new Promise(() => {});`,
    });
    await holder.until(' .');
    const pid = Number(/kid (\d+) \./.exec(holder.output())?.[1]);
    holder.child.kill('SIGKILL');
    await holder.child.exited;
    const lock = await tryLock();
    expect(readLedger(dir, lock).holds.map((entry) => entry.label)).toEqual(['holder']);
    process.kill(pid, 'SIGKILL');
    while (readLedger(dir, lock).holds.length > 0) await new Promise(setImmediate);
  }, 30_000);

  test('a request over the capacity runs alone instead of being refused', async () => {
    const dir = scratch();
    const huge = reserver({ dir, capacityMb: 10, mb: 50, label: 'huge', body: '' });
    expect(await huge.child.exited).toBe(0);
    expect(events(dir)[0]).toBe('+ 50 huge');
  }, 30_000);

  test('the view shows a live holder and a live waiter, oldest first', async () => {
    const dir = scratch();
    const holder = reserver({ dir, capacityMb: 10, mb: 10, label: 'holder' });
    await holder.until('held');
    const waiter = reserver({ dir, capacityMb: 10, mb: 5, label: 'waiter' });
    await waiter.until('waiting');
    const view = readLedger(dir, await tryLock());
    expect(view.holds.map((entry) => entry.label)).toEqual(['holder']);
    expect(view.queue.map((entry) => entry.label)).toEqual(['waiter']);
    holder.child.kill('SIGKILL');
    waiter.child.kill('SIGKILL');
    await Promise.all([holder.child.exited, waiter.child.exited]);
  }, 30_000);
});

describe('unitsThatFit', () => {
  const base = { capacityMb: 100, unitMb: 30, units: 3, minUnits: 1 };
  test('narrows to what is free, down to the minimum', () => {
    expect(unitsThatFit({ ...base, usedMb: 0 })).toBe(3);
    expect(unitsThatFit({ ...base, usedMb: 50 })).toBe(1);
    expect(unitsThatFit({ ...base, usedMb: 80 })).toBe(0);
  });
  test('an exact request takes all of it or waits', () => {
    expect(unitsThatFit({ ...base, minUnits: 3, usedMb: 50 })).toBe(0);
  });
  test('a unit over the capacity is granted once the ledger is empty', () => {
    expect(unitsThatFit({ ...base, unitMb: 500, usedMb: 0 })).toBe(1);
    expect(unitsThatFit({ ...base, unitMb: 500, usedMb: 1 })).toBe(0);
  });
});
