// 31.40.0: the services part appends only the env file's `TEST_` assignments to $GITHUB_ENV.
// `cat docker/test-services.env` handed GitHub the file's `#` header, and GitHub refuses the whole
// file ("Invalid format"), so every services part went red. One line swapped; an app that appends
// its own way is reported with the diff.

import { CI_WORKFLOW_PATH } from '../templates/github/ci.yml';
import type { Codemod } from './codemod';
import type { SnippetEdit } from './engine-edits';
import { editSnippets } from './engine-edits';

const CI = CI_WORKFLOW_PATH;

export const CI_SERVICES_ENV_EDITS: readonly SnippetEdit[] = [
  {
    from: '          cat docker/test-services.env >> "$GITHUB_ENV"',
    to: `          grep -E '^TEST_[A-Z0-9_]+=' docker/test-services.env >> "$GITHUB_ENV"`,
  },
];

export const codemod: Codemod = {
  id: 'ci-services-env',
  since: '31.40.0',
  summary: `${CI}: the services part appends only TEST_ lines to $GITHUB_ENV, never the env file's # header GitHub refuses`,
  run: (app) => editSnippets(app, CI, CI_SERVICES_ENV_EDITS),
};
