// 31.27.0: the CI part that runs `e2e` requires a browser (`E2E_BROWSER_REQUIRED=1`), so a runner
// with no Chrome is red with the command that locates one — never a step that skipped and passed.
// One step inserted after the test services start; an edited workflow is reported with the diff.

import type { Codemod } from './codemod';
import type { SnippetEdit } from './engine-edits';
import { editSnippets } from './engine-edits';

const CI = '.github/workflows/ci.yml';

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

export const codemod: Codemod = {
  id: 'ci-e2e-browser',
  since: '31.27.0',
  summary: `${CI}: the part that runs e2e requires a browser, so a runner with none is red, never skipped`,
  run: (app) => editSnippets(app, CI, CI_E2E_EDITS),
};
