// `{ needs }` on the typed registrars: a test that declares a real server runs where its variable
// is set and is skipped, with the reason in its name, where it is not. Proved in a child `bun test`
// because a skip is the runner's verdict — the counts and the `(skip)` line are the only witness.

import { expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import {
  missingServices,
  serviceSkipReason,
  TEST_SERVICE_ENV,
  TEST_SERVICES_START,
} from './test-types-services';

const HELPERS = join(import.meta.dir, 'test-types.ts');

/** One test per registrar needing postgres, one needing nothing, one needing postgres AND redis. */
const FIXTURE = `
import { contractTest, e2eTest, evalTest, jobTest, liveTest, unitTest } from ${JSON.stringify(HELPERS)};
const registrars = { unitTest, contractTest, liveTest, jobTest };
for (const [name, register] of Object.entries(registrars)) {
  register(name + ' needs pg', () => undefined, { needs: ['postgres'] });
}
unitTest('needs nothing', () => undefined);
unitTest('needs pg and redis', () => undefined, { needs: ['postgres', 'redis'] });
evalTest('evalTest needs pg', {
  threshold: 0.5,
  needs: ['postgres'],
  cases: [{ name: 'one', input: 1, score: () => 1 }],
  run: async (input) => input,
});
e2eTest('e2eTest needs pg', async () => undefined, { needs: ['postgres'] });
`;

async function runFixture(
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ readonly code: number; readonly output: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ultimate-test-needs-'));
  try {
    await Bun.write(join(dir, 'needs.test.ts'), FIXTURE);
    // The junit report names every skipped test; the terminal summary prints only the counts.
    const report = join(dir, 'report.xml');
    const run = Bun.spawn(
      ['bun', 'test', '--reporter=junit', `--reporter-outfile=${report}`, './needs.test.ts'],
      {
        cwd: dir,
        env: { ...Bun.env, ...env },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const output = `${await new Response(run.stdout).text()}${await new Response(run.stderr).text()}`;
    const code = await run.exited;
    return { code, output: `${output}${await Bun.file(report).text()}` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('unset: every registrar skips a test needing postgres, naming the variable and the start command', async () => {
  const { code, output } = await runFixture({ TEST_DATABASE_URL: '', TEST_REDIS_URL: undefined });
  expect(code).toBe(0);
  // Only `needs nothing` runs; the e2e one would skip with no driver anyway, so it counts once.
  expect(output).toContain(' 1 pass');
  expect(output).toContain(' 7 skip');
  expect(output).toContain('unit · unitTest needs pg (needs postgres (TEST_DATABASE_URL) unset:');
  expect(output).toContain('unit · needs pg and redis (needs postgres (TEST_DATABASE_URL), redis');
  expect(output).toContain('eval · evalTest needs pg (needs postgres');
}, 20_000);

test('set: the same tests run, and a second unset service still skips its test', async () => {
  const { code, output } = await runFixture({
    TEST_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
    TEST_REDIS_URL: '',
  });
  expect(code).toBe(0);
  // unit/contract/live/job + needs nothing + eval run; pg-and-redis skips; e2e has no driver.
  expect(output).toContain(' 6 pass');
  expect(output).toContain(' 2 skip');
  expect(output).toContain('needs pg and redis (needs redis (TEST_REDIS_URL) unset:');
}, 20_000);

test('a blank variable is unset, and the reason is a paste that starts the services', () => {
  expect(
    missingServices(['postgres', 'nats'], { TEST_DATABASE_URL: '  ', TEST_NATS_URL: 'x' }),
  ).toEqual(['postgres']);
  expect(serviceSkipReason([], {})).toBeUndefined();
  expect(serviceSkipReason(['nats'], { TEST_NATS_URL: 'nats://h:1' })).toBeUndefined();
  expect(serviceSkipReason(['nats'], {})).toBe(
    `needs nats (TEST_NATS_URL) unset: ${TEST_SERVICES_START}`,
  );
  expect(TEST_SERVICES_START.startsWith('docker compose -f docker/docker-compose.test.yml')).toBe(
    true,
  );
  expect(Object.values(TEST_SERVICE_ENV)).toEqual([
    'TEST_DATABASE_URL',
    'TEST_REDIS_URL',
    'TEST_NATS_URL',
  ]);
});
