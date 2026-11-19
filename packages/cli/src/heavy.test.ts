// Admission as a caller meets it: the reservation around work, the hold its children inherit, and
// one compiler per checkout, proven across real processes.

import { afterEach, describe, expect, test } from 'bun:test';
// why: temp ledgers and an append-only event log; Bun ships neither primitive.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
// why: the test's scratch root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { run } from '../../../scripts/lib/run';
import { exec } from './exec';
import { heavyState, withChild, withHeavy } from './heavy';
import { HEAVY_HOLD_ENV } from './heavy-env';

// flock(2) does not exist on Windows, where admission is off (`heavy-flock.ts`).
const NO_FLOCK = process.platform === 'win32';
const HEAVY = join(import.meta.dir, 'heavy.ts');
const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'heavy-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const envFor = (dir: string) => ({ ULTIMATE_HEAVY_DIR: dir, ULTIMATE_HEAVY_MEMORY: '100m' });
const request = (env: Record<string, string | undefined>) => ({
  label: 'work',
  cwd: '/w',
  env,
  unitMb: 100,
});

describe.skipIf(NO_FLOCK)('heavyState', () => {
  test('is off in CI and inside a test run, and an explicit ledger opts a test back in', async () => {
    expect(await heavyState({ CI: 'true' })).toMatchObject({ on: false, off: 'ci' });
    expect(await heavyState({ NODE_ENV: 'test' })).toMatchObject({ on: false, off: 'test-run' });
    const on = await heavyState({ NODE_ENV: 'test', ...envFor(scratch()) });
    expect(on.on).toBe(true);
  });

  // A fixture hands the code under test its own small env. Without this, every such test joined the
  // real machine queue, and one that timed out left a ticket ahead of every agent on the machine.
  test('inside a test process a narrowed env is off too: fixtures never join the real queue', async () => {
    expect(await heavyState({})).toMatchObject({ on: false, off: 'test-run' });
    expect((await heavyState(envFor(scratch()))).on).toBe(true);
  });

  test('ULTIMATE_HEAVY_MEMORY=0 is off', async () => {
    const state = await heavyState({ ...envFor(scratch()), ULTIMATE_HEAVY_MEMORY: '0' });
    expect(state).toMatchObject({ on: false, off: 'disabled' });
  });

  test('a hold whose owner is gone does not count as nesting', async () => {
    const dir = scratch();
    const env = { ...envFor(dir), [HEAVY_HOLD_ENV]: join(dir, 'holds', 'gone') };
    expect((await heavyState(env)).on).toBe(true);
  });
});

describe.skipIf(NO_FLOCK)('withHeavy', () => {
  test('children get the hold, and a run inside it reserves nothing more', async () => {
    const env = envFor(scratch());
    const inner = await withHeavy(request(env), async (child) => {
      expect(child.env[HEAVY_HOLD_ENV]).toContain('/holds/');
      expect(child.fds).toHaveLength(1);
      // The ledger is full now, so this returns only because the hold is honoured.
      return withHeavy(request({ ...env, ...child.env }), async (nested) => nested);
    });
    expect(inner.env[HEAVY_HOLD_ENV]).toBeUndefined();
    expect(inner.fds).toEqual([]);
  });

  test('the reservation is given back when the work throws', async () => {
    const env = envFor(scratch());
    const boom = { code: 'boom' };
    await expect(
      withHeavy(request(env), async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await withHeavy(request(env), async () => 'next')).toBe('next');
  });

  test('a test run spawns with its options untouched', async () => {
    const options = { cwd: '/w' };
    const seen = await withHeavy(request({ NODE_ENV: 'test' }), async (child) =>
      withChild(options, child),
    );
    expect(seen).toBe(options);
  });

  test('an unusable ledger is said once and the work still runs', async () => {
    const file = join(scratch(), 'a-file');
    await Bun.write(file, '');
    const env = { ULTIMATE_HEAVY_DIR: file, ULTIMATE_HEAVY_MEMORY: '100m' };
    expect(await withHeavy(request(env), async () => 'ran')).toBe('ran');
  });
});

describe.skipIf(NO_FLOCK)('a spawned child', () => {
  test('receives inherited descriptors through both spawn paths', async () => {
    const dir = scratch();
    await withHeavy(request(envFor(dir)), async (child) => {
      const probe = ['sh', '-c', 'true <&3'];
      const viaExec = await exec(probe, withChild({ cwd: dir }, child));
      const viaRun = await run(probe, { cwd: dir, inheritFds: child.fds });
      expect([viaExec.ok, viaRun.ok]).toEqual([true, true]);
      expect((await exec(probe, { cwd: dir })).ok).toBe(false);
    });
  });
});

describe.skipIf(NO_FLOCK)('withCheckoutLock', () => {
  test('two processes on one checkout never overlap, and a nested run still excludes', async () => {
    const dir = scratch();
    const root = scratch();
    const log = join(dir, 'events');
    const starts = join(dir, 'starts');
    const source = (name: string) => `
      import { withCheckoutLock } from ${JSON.stringify(HEAVY)};
      import { appendFileSync, readFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(starts)}, '${name}');
      await withCheckoutLock(
        { name: 'typecheck', root: ${JSON.stringify(root)}, env: Bun.env },
        { env: {}, fds: [] },
        async () => {
          appendFileSync(${JSON.stringify(log)}, '+${name}\\n');
          // Every run has started before anyone leaves, so a missing lock must show as overlap.
          while (readFileSync(${JSON.stringify(starts)}, 'utf8').length < 4) await Bun.sleep(5);
          await Bun.sleep(20);
          appendFileSync(${JSON.stringify(log)}, '-${name}\\n');
        },
      );`;
    // `CI` cleared: a CI runner has no ledger, so there the lock under test would not be taken.
    const env = {
      ...Bun.env,
      ...envFor(dir),
      CI: '',
      [HEAVY_HOLD_ENV]: join(dir, 'holds', 'parent'),
    };
    const runs = ['a', 'b', 'c', 'd'].map((name) =>
      Bun.spawn(['bun', '-e', source(name)], { env, stdout: 'ignore', stderr: 'ignore' }),
    );
    expect(await Promise.all(runs.map((run) => run.exited))).toEqual([0, 0, 0, 0]);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(8);
    for (let at = 0; at < lines.length; at += 2) {
      expect(lines[at]?.slice(1)).toBe(lines[at + 1]?.slice(1) as string);
    }
  }, 30_000);
});
