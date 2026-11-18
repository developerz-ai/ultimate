// 31.45.0: ci.yml's `verify-part-*` upload keeps its document one day. The verdict job reads it in
// the same run, and GitHub's 90-day default let one adopter's parts fill the org's artifact quota
// until CI could not run. Keyed on the upload's `name:` line, not the template's exact bytes, so an
// upload the app reshaped still gets it; one already holding a `retention-days` is the app's.

import { CI_WORKFLOW_PATH } from '../templates/github/ci.yml';
import type { Codemod, CodemodResult } from './codemod';
import { readText } from './engine-edits';

/** What the template writes at the end of the upload's `with:`, at its 10-column indent. */
export const RETENTION_LINES = [
  "          # The verdict reads it in this run only: kept GitHub's 90 days, every push's parts",
  "          # pile up until the org's artifact storage quota stops CI from running at all.",
  '          retention-days: 1',
  '',
].join('\n');

/** The stock upload's artifact name, at whatever indent the app's `with:` sits. */
const PART_NAME = /^( +)name: verify-part-\$\{\{ matrix\.part \}\}\s*$/;

const NOTHING: CodemodResult = { changed: [], skipped: [] };

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** The `with:` block holding line `at`: the run of non-blank lines at its indent or deeper. */
const blockAround = (lines: readonly string[], at: number, indent: number): [number, number] => {
  const inside = (line: string | undefined): boolean =>
    line !== undefined && line.trim() !== '' && indentOf(line) >= indent;
  let first = at;
  while (inside(lines[first - 1])) first -= 1;
  let last = at;
  while (inside(lines[last + 1])) last += 1;
  return [first, last];
};

const reindent = (indent: number): string[] =>
  RETENTION_LINES.trimEnd()
    .split('\n')
    .map((line) => `${' '.repeat(indent)}${line.trimStart()}`);

export const codemod: Codemod = {
  id: 'ci-artifact-retention',
  since: '31.45.0',
  summary: `${CI_WORKFLOW_PATH}: the verify-part-* upload the verdict reads in the same run keeps its document one day, never GitHub's 90`,
  run: async (app) => {
    const file = await readText(app, CI_WORKFLOW_PATH);
    if (file === undefined) return NOTHING;
    const lines = file.text.split('\n');
    // Bottom-up, so an insert never shifts a block still to be read.
    for (let at = lines.length - 1; at >= 0; at -= 1) {
      const indent = PART_NAME.exec(lines[at] ?? '')?.[1]?.length;
      if (indent === undefined) continue;
      const [first, last] = blockAround(lines, at, indent);
      const block = lines.slice(first, last + 1);
      if (block.some((line) => line.trimStart().startsWith('retention-days:'))) continue;
      lines.splice(last + 1, 0, ...reindent(indent));
    }
    const next = lines.join('\n');
    if (next === file.text) return NOTHING;
    await app.write(CI_WORKFLOW_PATH, file.restore(next));
    return { changed: [CI_WORKFLOW_PATH], skipped: [] };
  },
};
