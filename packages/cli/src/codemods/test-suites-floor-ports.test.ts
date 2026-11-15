// The three 31.27.0 scaffold codemods, over each file as the 31.26.0 scaffold wrote it: the live
// and e2e suites added where they have something to drive, the floor's `skip` rows for what cannot
// run (and `strict` only ever suggested), the test ports moved only off a byte-for-byte old file.

import { describe, expect, test } from 'bun:test';
import { names } from '../templates';
import {
  E2E_SUITE_PATH,
  e2eSuiteFiles,
  LIVE_SUITE_PATH,
  liveSuiteFiles,
} from '../templates/scaffold-suites';
import {
  TEST_COMPOSE_PATH,
  TEST_ENV_PATH,
  testServicesFiles,
} from '../templates/scaffold-test-services';
import { verifyFloor } from '../templates/scaffold-verify-floor';
import { memoryCodemodApp } from './codemod';
import { codemod as testPorts } from './test-ports';
import { codemod as testSuites } from './test-suites';
import { codemod as floorSkips } from './verify-floor-skips';

const text = (files: readonly { path: string; contents?: unknown }[], path: string): string =>
  String(files.find((file) => file.path === path)?.contents ?? '');

describe('unit · codemod test-suites', () => {
  test('both suites, as x new writes them, where the db package and the landing page are', async () => {
    const app = memoryCodemodApp({ 'packages/db/src/index.ts': '', 'apps/web/site/page.tsx': '' });
    expect(await testSuites.run(app)).toEqual({
      changed: [LIVE_SUITE_PATH, E2E_SUITE_PATH],
      skipped: [],
    });
    expect(app.files[LIVE_SUITE_PATH]).toBe(text(liveSuiteFiles(), LIVE_SUITE_PATH));
    expect(app.files[E2E_SUITE_PATH]).toBe(text(e2eSuiteFiles(), E2E_SUITE_PATH));
    expect(await testSuites.run(app)).toEqual({ changed: [], skipped: [] });
  });

  test('no landing page (the api shape) is no e2e suite; one the app wrote is kept', async () => {
    const app = memoryCodemodApp({
      'packages/db/src/index.ts': '',
      [LIVE_SUITE_PATH]: '// mine\n',
    });
    expect(await testSuites.run(app)).toEqual({ changed: [], skipped: [] });
    expect(app.files[LIVE_SUITE_PATH]).toBe('// mine\n');
  });
});

describe('unit · codemod verify-floor-skips', () => {
  const FLOOR = 'x.verify.json';
  /** Today's floor for an app with no job and a page, as 31.26.0 wrote it: no skip, no strict. */
  const today = JSON.parse(verifyFloor({ jobs: false, pages: true })) as Record<string, unknown>;
  const { skip, strict: _strict, ...old } = today;
  const render = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
  const site = { 'apps/web/site/page.tsx': '' };

  test('the scaffold’s own skip rows land after steps; strict is suggested, never set', async () => {
    const app = memoryCodemodApp({ [FLOOR]: render(old), ...site });
    const result = await floorSkips.run(app);
    expect(result.changed).toEqual([FLOOR]);
    const { strict: _s, ...expected } = today;
    expect(app.files[FLOOR]).toBe(render(expected));
    expect((JSON.parse(app.files[FLOOR] ?? '{}') as { skip: unknown }).skip).toEqual(skip);
    expect(result.skipped[0]?.reason).toContain('strict left off');
    expect(result.skipped[0]?.diff).toContain('+  "strict": true');
    expect((await floorSkips.run(app)).changed).toEqual([]);
  });

  test('a job suite, the roadmap file or a step already required keeps it unexcused; the app’s rows win', async () => {
    const app = memoryCodemodApp({
      [FLOOR]: render({ ...old, skip: { job: 'mine' }, strict: false }),
      'apps/web/a/b.job.test.ts': '',
      'docs/idea/14-roadmap.md': '',
    });
    const result = await floorSkips.run(app);
    // No page here, yet `e2e` is in `steps` already: required stays required.
    expect(JSON.parse(app.files[FLOOR] ?? '{}').skip).toEqual({ job: 'mine' });
    expect(result.changed).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  test('a floor that is not a JSON object is reported, untouched; no floor is nothing', async () => {
    const app = memoryCodemodApp({ [FLOOR]: '[1]\n' });
    expect((await floorSkips.run(app)).skipped[0]?.path).toBe(FLOOR);
    expect(app.files[FLOOR]).toBe('[1]\n');
    expect(await floorSkips.run(memoryCodemodApp({}))).toEqual({ changed: [], skipped: [] });
  });
});

describe('unit · codemod test-ports', () => {
  // `my-app` hashes to a non-zero offset, so its ports really move.
  const files = testServicesFiles(names('my-app'));
  const env = text(files, TEST_ENV_PATH);
  const compose = text(files, TEST_COMPOSE_PATH);
  /** What 31.26.0 wrote: the fixed band starts, and the old compose comment. */
  const OLD_ENV = [
    ...env.split('\n').slice(0, 3),
    'TEST_DATABASE_URL=postgres://my-app:my-app-test@127.0.0.1:55432/postgres',
    'TEST_REDIS_URL=redis://127.0.0.1:56379',
    'TEST_NATS_URL=nats://127.0.0.1:54222',
    'TEST_S3_URL=http://my-app:my-app-test@127.0.0.1:59000/my-app-test',
    '',
  ].join('\n');
  const oldCompose = (): string => {
    let out = compose.replace(
      "Ports are this app's own (its name picks\n# them), above the dev stack's, so both stacks — and two apps — run at once.",
      "Ports are the dev stack's plus 50000, so both run.",
    );
    const urls = /:(\d+)\/postgres\n.*:(\d+)\n.*:(\d+)\n.*:(\d+)\//.exec(env) ?? [];
    for (const [i, base] of ['55432', '56379', '54222', '59000'].entries()) {
      out = out.replaceAll(`127.0.0.1:${urls[i + 1] ?? ''}:`, `127.0.0.1:${base}:`);
    }
    return out;
  };

  test('an untouched old pair moves to this app’s own ports, exactly as x new writes them', async () => {
    expect(env).not.toContain(':55432/');
    const app = memoryCodemodApp({ [TEST_ENV_PATH]: OLD_ENV, [TEST_COMPOSE_PATH]: oldCompose() });
    expect(app.files[TEST_COMPOSE_PATH]).toContain('127.0.0.1:55432:5432');
    expect((await testPorts.run(app)).changed).toEqual([TEST_COMPOSE_PATH, TEST_ENV_PATH]);
    expect(app.files[TEST_ENV_PATH]).toBe(env);
    expect(app.files[TEST_COMPOSE_PATH]).toBe(compose);
    expect(await testPorts.run(app)).toEqual({ changed: [], skipped: [] });
  });

  test('an edited file keeps its ports and is reported with the diff; its untouched twin moves', async () => {
    const edited = `${oldCompose()}# mine\n`;
    const app = memoryCodemodApp({ [TEST_ENV_PATH]: OLD_ENV, [TEST_COMPOSE_PATH]: edited });
    const result = await testPorts.run(app);
    expect(app.files[TEST_COMPOSE_PATH]).toBe(edited);
    expect(result.skipped.map((skip) => skip.path)).toEqual([TEST_COMPOSE_PATH]);
    expect(result.skipped[0]?.diff).toContain("-    ports: ['127.0.0.1:55432:5432']");
    expect(result.changed).toEqual([TEST_ENV_PATH]);
  });

  test('no env file naming the app is nothing to do', async () => {
    expect(await testPorts.run(memoryCodemodApp({}))).toEqual({ changed: [], skipped: [] });
  });
});
