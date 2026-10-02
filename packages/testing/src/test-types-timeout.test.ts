// `{ timeoutMs }` on the six typed registrars — and on `test` itself — reaches `bun:test`. Proved in a child `bun test`,
// because a timeout is the runner's verdict on a test: the only honest witness is a run in which
// one test outlives its own deadline and the same body, given longer, does not.

import { expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import type { E2eBody, TestOptions } from './test-types';
import { e2eTest, resetE2eDriver, useE2eDriver } from './test-types';

const HELPERS = join(import.meta.dir, 'test-types.ts');
const FIXTURES = join(import.meta.dir, 'fixtures.ts');

/** Each helper twice over one 150 ms body: under a 20 ms deadline, and under a 2 s one. */
const FIXTURE = `
import { contractTest, evalTest, jobTest, liveTest, unitTest } from ${JSON.stringify(HELPERS)};
import { fixtureTest } from ${JSON.stringify(FIXTURES)};
const slow = () => Bun.sleep(150);
const registrars = { unitTest, contractTest, liveTest, jobTest };
// \`test\` from the barrel IS \`fixtureTest\`; named \`plain\` so the report line is its own.
fixtureTest('plain · fixtureTest short', slow, { timeoutMs: 20 });
fixtureTest('plain · fixtureTest long', slow, { timeoutMs: 2000 });
for (const [name, register] of Object.entries(registrars)) {
  register(name + ' short', slow, { timeoutMs: 20 });
  register(name + ' long', slow, { timeoutMs: 2000 });
}
const evalCase = (timeoutMs) => ({
  threshold: 0.5,
  timeoutMs,
  cases: [{ name: 'one', input: 1, score: () => 1 }],
  run: async (input) => { await slow(); return input; },
});
evalTest('evalTest short', evalCase(20));
evalTest('evalTest long', evalCase(2000));
`;

test('a test given timeoutMs is held to it by bun, and one given longer passes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ultimate-test-timeout-'));
  try {
    await Bun.write(join(dir, 'timeouts.test.ts'), FIXTURE);
    const run = Bun.spawn(['bun', 'test', './timeouts.test.ts'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = `${await new Response(run.stdout).text()}${await new Response(run.stderr).text()}`;
    expect(await run.exited).toBe(1);
    const helpers = ['unitTest', 'contractTest', 'liveTest', 'jobTest', 'evalTest', 'fixtureTest'];
    for (const helper of helpers) {
      expect(output).toMatch(new RegExp(`\\(fail\\) \\w+ · ${helper} short`));
      // Whether Bun prints a PASSING line depends on where it runs (a terminal, or GitHub Actions'
      // annotations); a failing one it always prints. The counts below are the witness.
      expect(output).not.toMatch(new RegExp(`\\(fail\\) \\w+ · ${helper} long`));
    }
    expect(output).toContain('timed out after 20ms');
    expect(output).toContain(' 6 pass');
    expect(output).toContain(' 6 fail');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test('e2eTest hands its options to the driver, which owns the registration', () => {
  const seen: (TestOptions | undefined)[] = [];
  useE2eDriver((_name, _body, options) => {
    seen.push(options);
  });
  try {
    const body: E2eBody = async () => undefined;
    e2eTest('with a deadline', body, { timeoutMs: 90_000 });
    e2eTest('without one', body);
    expect(seen).toEqual([{ timeoutMs: 90_000 }, undefined]);
  } finally {
    resetE2eDriver();
  }
});
