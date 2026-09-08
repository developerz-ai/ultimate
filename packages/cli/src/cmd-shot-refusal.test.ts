// The refusals `x shot` makes BEFORE it boots anything — a bad flag, a browser that is not there,
// an island argument that contradicts the route.
//
// Split out of `cmd-shot.test.ts`, which crossed the 500-line ceiling when these arrived. It is a
// separate responsibility and reads as one: every case here asserts that the command answers
// without starting a dev server, and a dev server means an embedded Postgres. The rest of the
// suite proves what `x shot` DOES; this file proves what it declines to start.

import { beforeAll, describe, expect, test } from 'bun:test';
import { REQUIRED_BUN } from './app-root';
import { shotCommand } from './cmd-shot';
import type { CommandContext } from './command';
import { DEV_LOCK_FILE } from './dev-lock';
import { parseArgs } from './parse';

/** The thrown value as a plain record, so a `code`/`fix` pair can be asserted in one expression. */
const thrownBy = async (run: () => Promise<unknown>): Promise<Record<string, unknown>> => {
  try {
    await run();
  } catch (error) {
    return error as unknown as Record<string, unknown>;
  }
  return expect.unreachable('expected x shot to refuse');
};

describe('unit · x shot refuses before it boots anything', () => {
  // The fixture app root has to be a directory this package does NOT resolve puppeteer-core from,
  // which is why it cannot be `import.meta.dir` — measured: six of these cases pass there for the
  // wrong reason.
  //
  // Built with `Bun.write` and `crypto.randomUUID()` rather than `mkdtempSync`, and that is not
  // style: `scripts/node-imports.ts` is a ratchet on this package's `node:` imports, and splitting
  // a file is not a licence to duplicate three of them. `Bun.write` creates the parent directories
  // it needs, so the directory and its two files are one call each.
  let root = '';

  /**
   * A file that exists and is not a browser. `CHROME_PATH` is set to it in every context below so
   * these assertions read the same on a machine with Chrome installed and on one without:
   * `executablePathFrom` probes `/usr/bin/google-chrome` and its three siblings, so a context with
   * an empty env answers a different refusal per host — a test whose verdict is the box it ran on.
   */
  let chromeStub = '';

  beforeAll(async () => {
    root = `${Bun.env['TMPDIR'] ?? '/tmp'}/x-shot-refusal-${crypto.randomUUID()}`;
    await Bun.write(`${root}/app.config.ts`, 'export const config = {};\n');
    chromeStub = `${root}/not-really-chrome`;
    await Bun.write(chromeStub, '');
  });

  /**
   * Whether anything booted. The dev lock is a FILE the dev server writes into `.x`, and that is
   * why it is the probe: `Bun.file()` answers `exists: false` for a directory, so asserting on
   * `.x` itself would be an assertion that cannot fail.
   */
  const startedADevServer = (): Promise<boolean> =>
    Bun.file(`${root}/.x/${DEV_LOCK_FILE}`).exists();

  const contextFor = (
    argv: readonly string[],
    env: Readonly<Record<string, string | undefined>> = { CHROME_PATH: chromeStub },
  ): CommandContext => ({
    args: parseArgs(argv, [shotCommand.spec]),
    cwd: root,
    runner: (command) => expect.unreachable(`x shot spawned ${command.join(' ')}`),
    env,
    bunVersion: REQUIRED_BUN,
  });

  test('a port that is not a port is a flag error, not a NaN handed to Bun.serve', async () => {
    const error = await thrownBy(() => shotCommand.run(contextFor(['shot', '/', '--port', 'abc'])));
    expect(error['code']).toBe('X_CLI_BAD_FLAG');
  });

  test('a --browser naming no executable is refused before the launch', async () => {
    const error = await thrownBy(() =>
      shotCommand.run(contextFor(['shot', '/', '--browser', '/no/such/chrome'])),
    );
    expect([error['code'], error['fix']]).toEqual([
      'X_CLI_BAD_FLAG',
      'x shot / --browser /usr/bin/chromium',
    ]);
  });

  /**
   * `--island` and a route positional are two subjects and one command, and the refusal comes
   * FIRST — ahead of `readRoute`, ahead of the browser, ahead of any boot. A reader who typed both
   * has a belief about which one runs and half of them would be wrong, so neither is preferred.
   */
  test('--island and a route positional are refused by name, before anything is resolved', async () => {
    const error = await thrownBy(() =>
      shotCommand.run(contextFor(['shot', '/dash', '--island', 'settings'])),
    );
    expect([error['code'], error['fix']]).toEqual([
      'X_CLI_BAD_FLAG',
      'x shot --island settings --json',
    ]);
    expect(await startedADevServer()).toBe(false);
  });

  /**
   * `--island` alone must NOT go through `readRoute`, which refuses a missing positional. This
   * app declares no states, so the refusal is the one that names that — and it lands before the
   * browser resolves, which is what `.x` staying absent proves.
   */
  test('--island alone skips the route positional entirely', async () => {
    const error = await thrownBy(() =>
      shotCommand.run(contextFor(['shot', '--island', 'settings'])),
    );
    expect(error['code']).toBe('X_CLI_BAD_FLAG');
    expect(String(error['cause'])).toContain('declares no island states');
    expect(await startedADevServer()).toBe(false);
  });

  /**
   * `--all-islands` is the whole app, and every other subject contradicts it. Each pair is refused
   * by NAME and before anything resolves — a reader who typed two subjects has a belief about
   * which one runs, and half of them would be wrong.
   */
  test('--all-islands beside another subject is refused, and nothing is started', async () => {
    for (const argv of [
      ['shot', '--all-islands', '--island', 'settings'],
      ['shot', '--all-islands', '/dash'],
      ['shot', '--all-islands', '--state', 'empty'],
    ]) {
      const error = await thrownBy(() => shotCommand.run(contextFor(argv)));
      expect(error['code']).toBe('X_CLI_BAD_FLAG');
      expect(String(error['fix'])).toContain('x shot --');
    }
    expect(await startedADevServer()).toBe(false);
  });

  /**
   * The outcome this whole command exists to make impossible, at the widest form it has: a sweep
   * over an app that declares no states must refuse by name, not exit 0 having photographed
   * nothing. A gallery with no pictures in it reads exactly like a clean run.
   */
  test('--all-islands in an app that declares no states refuses rather than producing nothing', async () => {
    const error = await thrownBy(() => shotCommand.run(contextFor(['shot', '--all-islands'])));
    expect(error['code']).toBe('X_CLI_BAD_FLAG');
    expect(String(error['cause'])).toContain('declares no island states');
    // The fix is a generator this build really ships — a `fix:` citing one it does not is the
    // failure `fix-command.ts` exists to catch.
    expect(String(error['fix'])).toContain('x g island');
    expect(await startedADevServer()).toBe(false);
  });

  /**
   * An operator's own answer, wrong. It is reported as the path it is rather than replaced by a
   * probed one: a run that photographs a page in a browser nobody chose is worse than a refusal.
   */
  test('a CHROME_PATH naming no executable is refused before the launch', async () => {
    const error = await thrownBy(() =>
      shotCommand.run(contextFor(['shot', '/'], { CHROME_PATH: '/no/such/chrome' })),
    );
    expect(error['code']).toBe('X_CLI_BAD_FLAG');
    expect(String(error['cause'])).toContain('/no/such/chrome');
    expect(await startedADevServer()).toBe(false);
  });

  // The whole point of resolving the browser first: an app with none must not pay an embedded
  // Postgres boot to be told to run one install command.
  test('an app with no puppeteer-core is told to install it, and nothing is started', async () => {
    const error = await thrownBy(() => shotCommand.run(contextFor(['shot', '/'])));
    expect([error['code'], error['fix']]).toEqual([
      'X_SHOT_BROWSER_MISSING',
      'bun add -d puppeteer-core',
    ]);
    expect(await startedADevServer()).toBe(false);
  });
});
