// The answer `scripts/template-codemods.ts` asks of every scaffold-owned template a release
// changes: the codemod that carries an app across (`packages/cli/src/codemods/<id>.ts`, listed in
// `codemods/index.ts` with the same `since`), or the written reason no app needs one. One row per
// template per release; a row at or below the last release tag is history and binds nothing.
import { TEMPLATE_CODEMOD_ROWS_31_40 } from './template-codemods-rows-31.40';
import { TEMPLATE_CODEMOD_HISTORY } from './template-codemods-rows-history';

export type TemplateCodemodRow =
  | { readonly template: string; readonly since: string; readonly codemod: string }
  | { readonly template: string; readonly since: string; readonly none: string };

export const TEMPLATE_CODEMOD_ROWS: readonly TemplateCodemodRow[] = [
  ...TEMPLATE_CODEMOD_HISTORY,
  {
    template: 'biome.json',
    since: '31.45.0',
    none: 'the merge updates only the `$schema` editor hint; an existing app keeps its installed Biome and its own config remains valid, so no codemod moves an app file',
  },
  {
    template: 'package.json',
    since: '31.45.0',
    none: "the root `@biomejs/biome` pin moves to 2.6.4 and every @ultimat3/* is written exact (D9), what x upgrade writes and x doctor's X_FRAMEWORK_PIN_RANGE asks for; an existing app retains its Biome, and its caret is moved exact by its next x upgrade hop, while x doctor names the line and the version",
  },
  {
    template: 'packages/cli/src/templates/scaffold-repo.ts',
    since: '31.45.0',
    none: 'x new now writes the 2.6.4 Biome pin and schema URL and every @ultimat3/* exact (D9); an existing app retains its valid Biome config, while its caret is moved exact by its next x upgrade hop and x doctor names the line and the version until then',
  },
  ...TEMPLATE_CODEMOD_ROWS_31_40,
  {
    template: 'packages/cli/src/templates/github/actions.ts',
    since: '31.43.0',
    codemod: 'ci-pinned-actions',
  },
  {
    template: 'packages/cli/src/templates/github/ci.yml.ts',
    since: '31.43.0',
    codemod: 'ci-pinned-actions',
  },
  {
    template: 'packages/cli/src/templates/github/image.yml.ts',
    since: '31.43.0',
    codemod: 'ci-pinned-actions',
  },
  {
    template: '.github/workflows/ci.yml',
    since: '31.43.0',
    codemod: 'ci-pinned-actions',
  },
  {
    template: '.github/workflows/image.yml',
    since: '31.43.0',
    codemod: 'ci-pinned-actions',
  },
  {
    template: 'packages/cli/src/templates/shapes/agent-prompt.ts',
    since: '31.44.0',
    none: "the agent shape's eval now refuses an edited template under its old version with X_EVAL_BASELINE_MISSING (re-record after bumping version), checked inside the one test that re-records, and files its baseline per version; an app's eval test, evals file and prompt are the author's — the old ones still gate on the scores and the hash, failing as X_TEST_FAILED rather than with the coded fix, so nothing breaks across the upgrade",
  },
  {
    template: 'apps/web/app/assistant/prompts/suggest-title.ts',
    since: '31.44.0',
    none: "the agent shape's eval now refuses an edited template under its old version with X_EVAL_BASELINE_MISSING (re-record after bumping version), checked inside the one test that re-records, and files its baseline per version; an app's eval test, evals file and prompt are the author's — the old ones still gate on the scores and the hash, failing as X_TEST_FAILED rather than with the coded fix, so nothing breaks across the upgrade",
  },
  {
    template: 'apps/web/app/assistant/prompts/suggest-title.evals.ts',
    since: '31.44.0',
    none: "the agent shape's eval now refuses an edited template under its old version with X_EVAL_BASELINE_MISSING (re-record after bumping version), checked inside the one test that re-records, and files its baseline per version; an app's eval test, evals file and prompt are the author's — the old ones still gate on the scores and the hash, failing as X_TEST_FAILED rather than with the coded fix, so nothing breaks across the upgrade",
  },
  {
    template: 'apps/web/app/assistant/prompts/suggest-title.eval.test.ts',
    since: '31.44.0',
    none: "the agent shape's eval now refuses an edited template under its old version with X_EVAL_BASELINE_MISSING (re-record after bumping version), checked inside the one test that re-records, and files its baseline per version; an app's eval test, evals file and prompt are the author's — the old ones still gate on the scores and the hash, failing as X_TEST_FAILED rather than with the coded fix, so nothing breaks across the upgrade",
  },
  {
    template: 'packages/cli/src/templates/shapes/offline.ts',
    since: '31.44.0',
    none: "the offline shape's /posts budget moves 155kb → 156kb for a new app: core's uuidV7 grew 12 B in each chunk (a pre-1970 clock mints at timestamp 0). An existing app keeps its own budget; one that lands over it gets X_BUDGET_EXCEEDED naming the measured bytes, and raises its budget there with the reason",
  },
  {
    template: 'apps/web/app/posts/page.tsx',
    since: '31.44.0',
    none: "the offline shape's /posts budget moves 155kb → 156kb for a new app: core's uuidV7 grew 12 B in each chunk (a pre-1970 clock mints at timestamp 0). An existing app keeps its own budget; one that lands over it gets X_BUDGET_EXCEEDED naming the measured bytes, and raises its budget there with the reason",
  },
  {
    template: 'apps/web/app/posts/page.test.ts',
    since: '31.44.0',
    none: "the offline shape's /posts budget moves 155kb → 156kb for a new app: core's uuidV7 grew 12 B in each chunk (a pre-1970 clock mints at timestamp 0). An existing app keeps its own budget; one that lands over it gets X_BUDGET_EXCEEDED naming the measured bytes, and raises its budget there with the reason",
  },
];
