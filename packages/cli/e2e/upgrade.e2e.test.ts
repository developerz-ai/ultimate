// The whole promise, once, for real: a scaffolded app that holds a real old release — whose own CLI
// has no `x upgrade` and answers `X_NOT_IMPLEMENTED` — takes the hop by the one line the wiki gives
// it, `bun x @ultimat3/cli@latest upgrade`, against a registry where this checkout IS the newest.
//
// Needs npm for the real old release: skips when npm does not answer, and refuses to under
// `E2E_NPM_REQUIRED=1`, which `ci.yml` sets.
//
//   bun test packages/cli/e2e/upgrade.e2e.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { ExecResult } from '../src/exec';
import { exec, execOutput } from '../src/exec';
import { LOCAL_CLI_BIN } from '../src/local-cli';

/** A real release, published forever, from before `x upgrade` existed. */
const FROM = '29.4.0';
/** What this checkout is stamped as in the fixture registry, whatever it really is. */
const TO = '30.0.0';
const GUARD = 'guards/bare-error.ts';
const REPO = join(import.meta.dir, '../../..');
const BIN = join(REPO, 'packages/cli/src/bin.ts');

/** Through the same proxy env `bun install` uses, so a dead proxy and a 5xx both read as no npm. */
const npmAnswers = (): boolean => {
  const probe = Bun.spawnSync(
    [process.execPath, 'pm', 'view', `@ultimat3/cli@${FROM}`, 'version'],
    {
      cwd: tmpdir(),
      timeout: 20_000,
      stdout: 'pipe',
      stderr: 'ignore',
    },
  );
  return probe.exitCode === 0 && probe.stdout.toString().includes(FROM);
};
const required = process.env['E2E_NPM_REQUIRED'] === '1';

let work = '';
let app = '';
let registry: ReturnType<typeof Bun.spawn> | undefined;
let env: Record<string, string | undefined> = {};

const must = async (result: Promise<ExecResult>): Promise<ExecResult> => {
  const done = await result;
  if (!done.ok) {
    expect.unreachable(
      `${done.command.join(' ')} exited ${String(done.code)}: ${execOutput(done)}`,
    );
  }
  return done;
};
const inApp = (command: readonly string[]): Promise<ExecResult> => exec(command, { cwd: app, env });
const commit = async (message: string): Promise<void> => {
  await must(inApp(['git', 'add', '-A']));
  await must(inApp(['git', 'commit', '-qm', message]));
};
/**
 * Every manifest that carries an `@ultimat3` range: the app's own and each workspace's.
 *
 * TWO patterns, never one brace group. Bun's expansion does not mix a literal filename with
 * patterns, so a group naming the root manifest beside the workspace ones matches NOTHING on
 * bun 1.4.4 — and a pin that pins nothing leaves the app exactly where it was, which reads as a
 * passing hop. The recursive spelling is the other one that works and the wrong one: it descends
 * into `node_modules` and rewrites every published manifest it finds there.
 */
const appManifests = async (): Promise<readonly string[]> => {
  const files = ['package.json'];
  for await (const file of new Bun.Glob('{apps,packages}/*/package.json').scan({ cwd: app })) {
    files.push(file);
  }
  return files;
};

const pinAll = async (version: string): Promise<void> => {
  const files = await appManifests();
  // A pin that changed nothing is a step that cannot fail: the app would stay where it was and
  // the hop would prove nothing.
  expect(files.length).toBeGreaterThan(1);
  for (const file of files) {
    const text = await Bun.file(join(app, file)).text();
    await Bun.write(
      join(app, file),
      text.replace(/("@ultimat3\/[a-z0-9-]+"\s*:\s*")[^"]*(")/g, `$1${version}$2`),
    );
  }
};

describe.skipIf(!required && !npmAnswers())('x upgrade, one real hop', () => {
  // The bound is the removal's own: `work` holds two full installs and a private install cache,
  // ~49k entries. Measured: 0.7–1.3 s on a local NVMe, 5.46 s on the ubuntu runner under
  // `--coverage` (ci run 42392549959, attempt 1), which bun's 5 s hook default failed as a timeout
  // though nothing was wrong. A minute is ten times the slowest measured, not a guess.
  afterAll(() => {
    registry?.kill();
    if (work !== '') rmSync(work, { recursive: true, force: true });
  }, 60_000);

  beforeAll(async () => {
    work = realpathSync(mkdtempSync(join(tmpdir(), 'ultimate-upgrade-e2e-')));
    app = join(work, 'hopper');
    registry = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, 'upgrade-registry-fixture.ts'),
        REPO,
        FROM,
        TO,
        work,
      ],
      { stdout: 'pipe', stderr: 'inherit', timeout: 1_500_000 },
    );
    const reader = (registry.stdout as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    const { url } = JSON.parse(new TextDecoder().decode(value)) as { readonly url: string };
    // A cache of its own: a stamped 30.0.0 from an earlier run must never stand in for this checkout.
    env = {
      NPM_CONFIG_REGISTRY: url,
      BUN_INSTALL_CACHE_DIR: join(work, 'bun-cache'),
      TMPDIR: work,
      GIT_AUTHOR_NAME: 'e2e',
      GIT_AUTHOR_EMAIL: 'e2e@example.com',
      GIT_COMMITTER_NAME: 'e2e',
      GIT_COMMITTER_EMAIL: 'e2e@example.com',
      NODE_ENV: undefined,
      DATABASE_URL: undefined,
      TEST_DATABASE_URL: undefined,
    };
    await must(exec([process.execPath, BIN, 'new', 'hopper', '--dir', work], { cwd: work, env }));
    // The app as `x new` at the newest release leaves it, first run included…
    await pinAll(TO);
    await must(inApp([process.execPath, 'install']));
    await must(inApp([process.execPath, 'run', 'setup']));
    // …then an author's own edit to a guard, and the pins walked back to the old release.
    await Bun.write(
      join(app, GUARD),
      `${await Bun.file(join(app, GUARD)).text()}// this app's own line\n`,
    );
    await pinAll(FROM);
    await must(inApp([process.execPath, 'install']));
    await commit('the app, one major behind');
  }, 600_000);

  test('an old app takes the hop with the newest CLI, and the report says what is left', async () => {
    const installed = async (): Promise<string> =>
      (
        (await Bun.file(join(app, 'node_modules/@ultimat3/cli/package.json')).json()) as {
          version: string;
        }
      ).version;
    expect(await installed()).toBe(FROM);

    // The premise: the app's own CLI cannot do this, so anything answering below is the newest one.
    const own = await inApp([process.execPath, join(app, LOCAL_CLI_BIN), 'upgrade', '--json']);
    expect(JSON.parse(own.stdout).findings[0].code).toBe('X_NOT_IMPLEMENTED');

    const dry = await inApp([
      process.execPath,
      'x',
      '@ultimat3/cli@latest',
      'upgrade',
      '--dry-run',
      '--json',
    ]);
    expect(execOutput(dry)).not.toContain('X_NOT_IMPLEMENTED');
    expect(JSON.parse(dry.stdout).data).toMatchObject({ from: FROM, to: TO, dryRun: true });
    expect(await must(inApp(['git', 'status', '--porcelain']))).toMatchObject({ stdout: '' });

    const hop = await inApp([process.execPath, 'x', '@ultimat3/cli@latest', 'upgrade', '--json']);
    const report = JSON.parse(hop.stdout);

    // Exactly one document on fd 1, and the exit code is the verdict.
    expect(report.command).toBe('upgrade');
    expect(hop.code === 0).toBe(report.data.done);
    expect(report.data.done).toBe(report.data.verify.ok);
    expect(report.data).toMatchObject({
      from: FROM,
      to: TO,
      next: null,
      section: {
        title: '29.x → 30.0.0, entry by entry',
        url: 'https://github.com/developerz-ai/ultimate/wiki/Upgrading#29x--3000-entry-by-entry',
      },
    });

    // The hop happened, for every workspace, through the installed tree.
    expect(await installed()).toBe(TO);
    const pins = await Bun.file(join(app, 'package.json')).text();
    expect(pins).not.toContain(`"${FROM}"`);
    expect(pins).toContain(`"@ultimat3/cli": "${TO}"`);

    // The local guard edit survives, is offered, and nothing was committed.
    expect((await must(inApp(['git', 'diff', '--', 'guards/']))).stdout).toBe('');
    expect(report.data.guards.reported).toBe(true);
    expect(report.data.guards.differs.map((guard: { name: string }) => guard.name)).toContain(
      'bare-error',
    );
    expect((await must(inApp(['git', 'rev-list', '--count', 'HEAD']))).stdout.trim()).toBe('2');

    // The gate really ran, and a scaffold one hop on is green. `budgets` alone may be red: nothing in
    // this hop has built, and that step's finding names the build.
    expect(report.data.verify.failed.filter((step: string) => step !== 'budgets')).toEqual([]);
    expect(report.data.verify.summary.length).toBeGreaterThan(0);
    for (const finding of report.data.verify.findings) {
      expect(finding.code).toStartWith('X_');
      expect(finding.fix.length).toBeGreaterThan(0);
    }

    // The next walk's refusal: an uncommitted hop must be committed first.
    const again = await inApp([process.execPath, 'x', '@ultimat3/cli@latest', 'upgrade', '--json']);
    expect(JSON.parse(again.stdout).findings[0].code).toBe('X_UPGRADE_DIRTY_TREE');
  }, 1_200_000);
});
