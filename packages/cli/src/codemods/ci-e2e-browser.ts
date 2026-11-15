// 31.27.0: the CI part that runs `e2e` requires a browser (`E2E_BROWSER_REQUIRED=1`), so a runner
// with no Chrome is red with the command that locates one — never a step that skipped and passed.
// One step inserted after the test services start; the one-job workflow of 31.4–31.15, still
// byte for byte, is replaced whole by today's. An edited workflow is reported with the diff.

import { CI_WORKFLOW_PATH, githubFiles } from '../templates/github/ci.yml';
import { names } from '../templates/naming';
import { appName } from './agents-dev-mcp';
import { CI_31_15_LINES } from './ci-e2e-browser-stock';
import type { Codemod, CodemodApp, CodemodResult } from './codemod';
import type { FileText, SnippetEdit } from './engine-edits';
import { editSnippets, readText } from './engine-edits';

const CI = CI_WORKFLOW_PATH;

const lines = (...text: readonly string[]): string => text.join('\n');

const START = lines(
  '          docker compose -f docker/docker-compose.test.yml up -d --wait',
  '          cat docker/test-services.env >> "$GITHUB_ENV"',
);
const NEXT =
  '      # Under $RUNNER_TEMP, never in the checkout, where `lint` would walk the open file.';

export const CI_E2E_EDITS: readonly SnippetEdit[] = [
  {
    from: lines(START, NEXT),
    to: lines(
      START,
      '      # ubuntu-latest ships Chrome, and the `e2e` step finds it. Required here, so a runner that',
      '      # has none (a `CI_RUNNER` label) is red with the command that locates one — never a skip.',
      "      - if: contains(matrix.only, 'e2e')",
      '        run: echo "E2E_BROWSER_REQUIRED=1" >> "$GITHUB_ENV"',
      NEXT,
    ),
  },
];

/** Every `bun-version:` line alike: a runtime-pin codemod may have moved it already. */
const pinless = (text: string): string => text.replace(/^(\s*bun-version:).*$/gm, '$1');

/** Today's workflow, when the app's is still the 31.4–31.15 one-job workflow exactly. */
async function wholeFile(app: CodemodApp, held: FileText): Promise<CodemodResult | undefined> {
  const name = appName((await readText(app, 'package.json'))?.text ?? '');
  if (name === undefined) return undefined;
  const stock = CI_31_15_LINES.map((line) => line.replace('<APP>', name)).join('\n');
  if (pinless(held.text) !== pinless(stock)) return undefined;
  const today = githubFiles(names(name)).find((file) => file.path === CI)?.contents;
  if (typeof today !== 'string') return undefined;
  await app.write(CI, held.restore(today));
  return { changed: [CI], skipped: [] };
}

export const codemod: Codemod = {
  id: 'ci-e2e-browser',
  since: '31.27.0',
  summary: `${CI}: the part that runs e2e requires a browser, so a runner with none is red, never skipped`,
  async run(app) {
    const held = await readText(app, CI);
    if (held === undefined) return { changed: [], skipped: [] };
    return (await wholeFile(app, held)) ?? editSnippets(app, CI, CI_E2E_EDITS);
  },
};
