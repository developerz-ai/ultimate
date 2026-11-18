// The ci-weekly-schedule codemod: a ci.yml and dependabot.yml as 31.46 wrote them come back as `x new`
// writes them today; a workflow that already has its own schedule, or that no longer holds the
// template's text, stays exactly as the app left it.

import { describe, expect, test } from 'bun:test';
import { CI_WORKFLOW_PATH, githubFiles } from '../templates/github/ci.yml';
import { DEPENDABOT_PATH } from '../templates/github/dependabot.yml';
import { names } from '../templates/naming';
import { codemod as ciArtifactRetention } from './ci-artifact-retention';
import { codemod as ciPinnedActions } from './ci-pinned-actions';
import { codemod } from './ci-weekly-schedule';
import { memoryCodemodApp } from './codemod';
import { pendingCodemods } from './engine';
import { CODEMODS } from './index';

const today = (path: string, app = 'shop'): string =>
  String(githubFiles(names(app)).find((file) => file.path === path)?.contents);

/** 31.46's three lines, spelled here and not read off the codemod. */
const OLD_GROUP = [
  'concurrency:\n  group: ci-$',
  "{{ github.ref == format('refs/heads/{0}', github.event.repository.default_branch) && github.sha || github.ref }}\n",
].join('');
const OLD_IF =
  "    if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name != github.repository\n";

const olderCi = (app = 'shop'): string =>
  today(CI_WORKFLOW_PATH, app)
    .replace(/( {2}pull_request:\n)(?: +#.*\n)* +schedule:\n +- cron: .*\n/, '$1')
    .replace(/concurrency:\n(?: +#.*\n)* +group: .*\n/, OLD_GROUP)
    .replace(/(?: +# A scheduled run.*\n(?: +#.*\n)*)? +if: github\.event_name != .*\n/, OLD_IF)
    .replace(/\n(?: +#.*\n)+ +alarm:\n[\s\S]*$/, '');

const olderDependabot = (): string =>
  today(DEPENDABOT_PATH).replace(/(?: +#.*\n)* +- dependency-name: oven\/bun\n/, '');

const stock = (ci = olderCi(), dependabot = olderDependabot()) =>
  memoryCodemodApp({ [CI_WORKFLOW_PATH]: ci, [DEPENDABOT_PATH]: dependabot });

describe('unit · codemod ci-weekly-schedule', () => {
  test('x upgrade runs it on the hop into 31.47.0, and not on one past it', () => {
    expect(pendingCodemods(CODEMODS, '31.46.0', '31.47.0')).toContain(codemod);
    expect(pendingCodemods(CODEMODS, '31.47.0', '31.48.0')).not.toContain(codemod);
  });

  test('the fixture really is the older file', () => {
    expect(olderCi()).not.toMatch(/schedule|alarm|issues:/);
    expect(olderCi()).toContain(OLD_GROUP);
    expect(olderCi()).toContain(OLD_IF);
    expect(olderCi().endsWith('parts/*.json\n')).toBe(true);
    expect(olderDependabot()).not.toContain('oven/bun');
  });

  test('both files as 31.46 wrote them come back as x new writes them today, and stay', async () => {
    const app = stock();
    expect(await codemod.run(app)).toEqual({
      changed: [CI_WORKFLOW_PATH, DEPENDABOT_PATH],
      skipped: [],
    });
    expect(app.files[CI_WORKFLOW_PATH]).toBe(today(CI_WORKFLOW_PATH));
    expect(app.files[DEPENDABOT_PATH]).toBe(today(DEPENDABOT_PATH));
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
  });

  test('the cron is the one x new would pick for this app', async () => {
    const app = stock(olderCi('ledger-demo'));
    await codemod.run(app);
    expect(app.files[CI_WORKFLOW_PATH]).toBe(today(CI_WORKFLOW_PATH, 'ledger-demo'));
  });

  test('CRLF survives', async () => {
    const app = stock(olderCi().replaceAll('\n', '\r\n'));
    await codemod.run(app);
    expect(app.files[CI_WORKFLOW_PATH]).toBe(today(CI_WORKFLOW_PATH).replaceAll('\n', '\r\n'));
  });

  // The adopters that patched this by hand: their cron, group and conditions are theirs.
  test('a workflow with its own schedule is the app’s, and left byte for byte', async () => {
    const own = olderCi().replace(
      '  pull_request:\n',
      "  pull_request:\n  schedule:\n    - cron: '41 2 * * *'\n",
    );
    const app = stock(own);
    expect(await codemod.run(app)).toEqual({ changed: [DEPENDABOT_PATH], skipped: [] });
    expect(app.files[CI_WORKFLOW_PATH]).toBe(own);
  });

  test('a schedule below a column-0 comment is still the app’s: no second key', async () => {
    const own = olderCi().replace(
      '  pull_request:\n',
      "  pull_request:\n# nightly\n  schedule:\n    - cron: '41 2 * * *'\n",
    );
    const app = stock(own);
    await codemod.run(app);
    expect(app.files[CI_WORKFLOW_PATH]).toBe(own);
  });

  test('a job merely called schedule does not read as the trigger', async () => {
    const own = olderCi().replace('jobs:\n', 'jobs:\n  schedule:\n    runs-on: ubuntu-latest\n');
    const app = stock(own);
    expect((await codemod.run(app)).changed).toContain(CI_WORKFLOW_PATH);
    expect(app.files[CI_WORKFLOW_PATH]).toContain('- cron: ');
  });

  test('a reworked workflow is reported with the diff, and not one byte moves', async () => {
    const own = olderCi().replace('  push:\n', '  push:\n    branches: [main]\n');
    const app = stock(own);
    const result = await codemod.run(app);
    expect(result.changed).toEqual([DEPENDABOT_PATH]);
    expect(result.skipped.map((skip) => skip.path)).toEqual([CI_WORKFLOW_PATH]);
    expect(result.skipped[0]?.diff).toContain('+  schedule:');
    expect(app.files[CI_WORKFLOW_PATH]).toBe(own);
  });

  test('a dependabot.yml already ignoring oven/bun anywhere gets no second entry', async () => {
    const own = `${olderDependabot()}# by hand\n      - dependency-name: oven/bun\n`;
    const app = stock(olderCi(), own);
    expect((await codemod.run(app)).changed).toEqual([CI_WORKFLOW_PATH]);
    expect(app.files[DEPENDABOT_PATH]).toBe(own);
  });

  test('an app without the files is nothing to do', async () => {
    expect(await codemod.run(memoryCodemodApp({}))).toEqual({ changed: [], skipped: [] });
  });

  test('the earlier workflow codemods read today’s file as already carried', async () => {
    const app = memoryCodemodApp({ [CI_WORKFLOW_PATH]: today(CI_WORKFLOW_PATH) });
    expect(await ciPinnedActions.run(app)).toEqual({ changed: [], skipped: [] });
    expect(await ciArtifactRetention.run(app)).toEqual({ changed: [], skipped: [] });
  });
});
