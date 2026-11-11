// `changelog-check`'s guard-refresh rule against the files this repo really ships: green, and red
// once the rows are stripped — so the green is the rows, not a rule that read nothing. Beside the
// host's own real-tree tests, split out of `changelog-check.test.ts` at its 500-line ceiling.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { UPGRADING_PATH } from './changelog-check';
import { loadChangelog } from './lib/changelog-store';
import { guardRefreshFindings } from './lib/guard-refresh-git';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Reads git and may fetch two tags into a clone that lacks them: the repo-scan backstop.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

describe('the guard-refresh rule, on this repo', () => {
  // The twelve guard templates 31.4.1 changed (`git diff --name-only v31.4.0 v31.4.1 --
  // packages/cli/src/templates/`), and the page's rows naming them. Strip every `x g guard` line
  // and the same tree is red — so the green is the rows, not a rule that read nothing.
  test('every guard template the last release changed is named with its x g guard refresh', async () => {
    const root = repoRoot();
    const changelog = await loadChangelog(root);
    const upgrading = await Bun.file(`${root}/${UPGRADING_PATH}`).text();
    expect(await guardRefreshFindings(root, changelog, upgrading)).toEqual([]);
    const stripped = upgrading
      .split('\n')
      .filter((line) => !line.includes('x g guard'))
      .join('\n');
    const red = await guardRefreshFindings(root, changelog, stripped);
    const latest = changelog.find((section) => section.released)?.version;
    // The named twelve hold while 31.4.1 is the newest section; past it the green above still holds.
    if (latest !== '31.4.1') return;
    const cause = red.find((finding) => finding.cause.includes('31.4.0 → 31.4.1'))?.cause ?? '';
    for (const guard of [
      'bare-error',
      'error-declared',
      'image-dimensions',
      'native-confirm',
      'raw-fetch',
      'raw-interval',
      'raw-motion',
      'semantic-interactive',
      'undeclared-custom-property',
      'undefined-style-class',
      'untranslated-string',
      'unzoned-date',
    ]) {
      expect(cause).toContain(guard);
    }
  });
});
