// The premise a widened unit's reading rests on, held against the real `bun`: under `--parallel`,
// every file isolated, Bun folds the coverage of every file and every worker into ONE lcov by
// function identity — a function called only in another file, in this worker or another, is hit —
// so N workers read what one process reads. Bun's lcov carries no `FN:` lines, so this gate could
// never union functions itself; if a Bun upgrade folds them by count instead (the best one file or
// worker reached), or keeps the last isolated file's record as an older Bun did, this goes red.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive; the fixture is a real tree a child `bun test` runs.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { parseLcov } from '../packages/cli/src/coverage-lcov';
import { testCommand } from './coverage-gate';
import { unitOf } from './lib/coverage-units';

/** Three functions; each test file calls exactly one, and sleeps so the files spread over workers. */
const MODULE = [
  'export function f(x: number) {',
  '  // a comment inside f',
  '',
  '  if (x > 0) {',
  '    return 1;',
  '  }',
  '  return 0;',
  '}',
  'export function g() {',
  '  return 2;',
  '}',
  'export function h() {',
  '  return 3;',
  '}',
].join('\n');

const testFile = (name: string, call: string): string =>
  [
    "import { expect, test } from 'bun:test';",
    `import { ${name} } from './m';`,
    `test('${name}', async () => {`,
    "  console.log('worker', process.pid);",
    '  await Bun.sleep(300);',
    `  expect(${call}).toBeGreaterThan(0);`,
    '});',
  ].join('\n');

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'coverage-parallel-'));
  await Bun.write(join(dir, 'm.ts'), MODULE);
  await Bun.write(join(dir, 'a.test.ts'), testFile('f', 'f(1)'));
  await Bun.write(join(dir, 'b.test.ts'), testFile('g', 'g()'));
  await Bun.write(join(dir, 'c.test.ts'), testFile('h', 'h()'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Runs the fixture the way the gate runs a unit of `workers` workers; answers m.ts's record. */
async function measured(workers: number): Promise<{ record: unknown; pids: number }> {
  const out = join(dir, `cov-${String(workers)}`);
  const argv = testCommand({ ...unitOf('fixture'), test: '.' }, out, workers);
  // `--parallel-delay=0` only for the fixture: three 300 ms files would otherwise all fit in the
  // first worker's start-up window, and the premise would be tested on one process.
  const forced = workers > 1 ? [...argv.slice(0, -1), '--parallel-delay=0', '.'] : argv;
  const proc = Bun.spawn([...forced], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect({ exit: await proc.exited, stderr: stderr.includes('(fail)') }).toEqual({
    exit: 0,
    stderr: false,
  });
  const pids = new Set([...`${stdout}\n${stderr}`.matchAll(/worker (\d+)/g)].map((m) => m[1]));
  const lcov = await Bun.file(join(out, 'lcov.info')).text();
  const record = parseLcov(lcov).find((one) => one.file.endsWith('m.ts'));
  return {
    record: record && {
      linesFound: record.linesFound,
      linesHit: record.linesHit,
      funcsFound: record.funcsFound,
      funcsHit: record.funcsHit,
    },
    pids: pids.size,
  };
}

describe("a widened unit reads what one process reads — Bun's merge is by function identity", () => {
  test('one worker is the command the gate always ran: no --parallel at all', () => {
    const argv = testCommand(unitOf('money'), '/out', 1);
    expect(argv).toEqual([
      'bun',
      'test',
      '--coverage',
      '--coverage-reporter=lcov',
      '--coverage-dir=/out',
      './packages/money',
    ]);
  });

  test('more than one is --parallel, every file isolated — never a registry shared by the clock', () => {
    const argv = testCommand(unitOf('cli'), '/out', 4);
    expect(argv).toContain('--parallel=4');
    // `--no-isolate` lets the files one worker happens to draw share a registry, and which files
    // those are is timing: a suite's verdict would move between runs.
    expect(argv).not.toContain('--no-isolate');
    expect(argv.at(-1)).toBe('./packages/cli');
  });

  test('three files over two workers, each calling one function, read all three hit', async () => {
    const one = await measured(1);
    const two = await measured(2);
    // The premise is only tested if the files really ran in two processes — so one of them ran
    // two files, each in its own global.
    expect(two.pids).toBe(2);
    expect(two.record).toEqual(one.record);
    expect(two.record).toMatchObject({ funcsFound: 3, funcsHit: 3 });
  });
});
