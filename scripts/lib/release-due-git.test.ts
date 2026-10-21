// The git `release-due` runs: through `run()`'s deadline, with its own shorter one, and in an
// environment where nothing it starts can prompt, page or redirect it. The deadline itself — a
// grandchild holding stdout, a child that never exits, stdin — is proved in `run.test.ts`.

import { describe, expect, test } from 'bun:test';
import { GIT_QUIET, GIT_TIMEOUT_MS, git, gitEnv } from './release-due-git';
import { DEFAULT_RUN_TIMEOUT_MS } from './run';

const cwd = import.meta.dir;

describe('unit · release-due-git · git', () => {
  test('runs git through run(), answering its output and exit code', async () => {
    const out = await git(['--version'], cwd);
    expect(out).toMatchObject({ ok: true, code: 0, timedOut: false });
    expect(out.command).toEqual(['git', ...GIT_QUIET, '--version']);
    expect(out.output).toStartWith('git version');
  });

  test('a git that is refused is reported, never thrown', async () => {
    // An unknown option: git's own parser refuses it at once. An unknown subcommand made git scan
    // every PATH entry for a `git-<name>` helper, which outran the 5 s test deadline on Windows CI.
    const out = await git(['--no-such-option-780'], cwd);
    expect(out).toMatchObject({ ok: false, timedOut: false });
  });

  test('its deadline is shorter than the default one', () => {
    expect(GIT_TIMEOUT_MS).toBeLessThan(DEFAULT_RUN_TIMEOUT_MS);
  });
});

describe('unit · release-due-git · gitEnv', () => {
  test('no inherited GIT_* reaches git, and nothing it runs can prompt or page', () => {
    const env = gitEnv({ GIT_AUTHOR_NAME: 't' }, { PATH: '/bin', GIT_DIR: '/elsewhere/.git' });
    expect(env['GIT_DIR']).toBeUndefined();
    expect(env).toMatchObject({
      PATH: '/bin',
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      GIT_EDITOR: 'true',
      GIT_AUTHOR_NAME: 't',
    });
  });
});
