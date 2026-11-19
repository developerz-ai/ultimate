// The answer `scripts/template-codemods.ts` asks of every scaffold-owned template a release
// changes: the codemod that carries an app across (`packages/cli/src/codemods/<id>.ts`, listed in
// `codemods/index.ts` with the same `since`), or the written reason no app needs one. One row per
// template per release; a row at or below the last release tag is history and binds nothing.
import { TEMPLATE_CODEMOD_ROWS_31_40 } from './template-codemods-rows-31.40';
import { TEMPLATE_CODEMOD_HISTORY } from './template-codemods-rows-history';

export type TemplateCodemodRow =
  | { readonly template: string; readonly since: string; readonly codemod: string }
  | { readonly template: string; readonly since: string; readonly none: string };

const BRIEF_TYPECHECK_WHY =
  "an agent brief now names bunx x verify --only typecheck, which queues in the machine ledger; an existing app's brief still names bun run typecheck, which keeps working, and its .claude files are the app's to edit, so x upgrade leaves them alone";

const WORKER_BRIEF_WHY =
  "the agent briefs now tell a worker with a file set to skip the gate and stop allowing the raw typecheck and lint scripts; an existing app's .claude files are the app's to edit and keep working, so x upgrade leaves them alone";

export const TEMPLATE_CODEMOD_ROWS: readonly TemplateCodemodRow[] = [
  ...TEMPLATE_CODEMOD_HISTORY,
  ...[
    'packages/cli/src/templates/scaffold-gitattributes.ts',
    'packages/cli/src/templates/scaffold-bin.ts',
    '.gitattributes',
    'bin/setup.ts',
    'apps/web/api/index.ts',
    'apps/web/exercise.ts',
    'apps/web/shared/roles.ts',
    'packages/db/src/client.ts',
  ].map((template) => ({ template, since: '31.49.0', codemod: 'merge-drivers' })),
  {
    template: 'packages/cli/src/templates/scaffold-docs.ts',
    since: '31.49.0',
    codemod: 'docs-worker-commands',
  },
  { template: 'CLAUDE.md', since: '31.49.0', codemod: 'docs-worker-commands' },
  { template: 'AGENTS.md', since: '31.49.0', codemod: 'docs-worker-commands' },
  ...[
    'packages/cli/src/templates/scaffold-claude.ts',
    'packages/cli/src/templates/scaffold-claude-commands.ts',
    '.claude/README.md',
    '.claude/settings.json',
    '.claude/commands/feature.md',
    '.claude/commands/verify.md',
  ].map((template) => ({ template, since: '31.49.0', none: WORKER_BRIEF_WHY })),
  {
    template: 'README.md',
    since: '31.49.0',
    none: "README.md gains a paragraph on merging two features' generated files; a README is the app's own prose, and an existing app reads the same rule on the wiki's Many-Agents page, so x upgrade leaves it alone",
  },
  {
    template: 'packages/cli/src/templates/scaffold-docs.ts',
    since: '31.48.0',
    codemod: 'docs-many-agents',
  },
  { template: 'CLAUDE.md', since: '31.48.0', codemod: 'docs-many-agents' },
  { template: 'AGENTS.md', since: '31.48.0', codemod: 'docs-many-agents' },
  {
    template: 'packages/cli/src/templates/scaffold-claude-agents.ts',
    since: '31.48.0',
    none: BRIEF_TYPECHECK_WHY,
  },
  {
    template: 'packages/cli/src/templates/scaffold-claude-commands.ts',
    since: '31.48.0',
    none: BRIEF_TYPECHECK_WHY,
  },
  {
    template: '.claude/agents/data.md',
    since: '31.48.0',
    none: BRIEF_TYPECHECK_WHY,
  },
  {
    template: '.claude/agents/server.md',
    since: '31.48.0',
    none: BRIEF_TYPECHECK_WHY,
  },
  {
    template: '.claude/agents/web.md',
    since: '31.48.0',
    none: BRIEF_TYPECHECK_WHY,
  },
  {
    template: '.claude/commands/feature.md',
    since: '31.48.0',
    none: BRIEF_TYPECHECK_WHY,
  },
  {
    template: 'packages/cli/src/templates/github/ci.yml.ts',
    since: '31.47.0',
    codemod: 'ci-weekly-schedule',
  },
  {
    template: 'packages/cli/src/templates/github/ci-schedule.ts',
    since: '31.47.0',
    codemod: 'ci-weekly-schedule',
  },
  {
    template: 'packages/cli/src/templates/github/dependabot.yml.ts',
    since: '31.47.0',
    codemod: 'ci-weekly-schedule',
  },
  {
    template: '.github/workflows/ci.yml',
    since: '31.47.0',
    codemod: 'ci-weekly-schedule',
  },
  {
    template: '.github/dependabot.yml',
    since: '31.47.0',
    codemod: 'ci-weekly-schedule',
  },
  {
    template: 'packages/cli/src/templates/sign-in-shared.ts',
    since: '31.46.0',
    none: "x new's destroySession now answers a browser form with native: { success: (output) => output.next } and sign-in-flow.ts drops landAt (D10); an existing app's landAt still sends the 303 through setRedirect, which the native answer honours too, so it keeps working unchanged — the optional move is in wiki/Upgrading.md",
  },
  {
    template: 'packages/cli/src/templates/sign-in-password.ts',
    since: '31.46.0',
    none: "x new's createSession and confirmSession declare native: { success: (output) => output.next } in place of landAt (D10); an existing app's landAt-based actions still answer its forms with a 303, and rewriting an action an app owns is not a safe mechanical edit — the optional move is in wiki/Upgrading.md",
  },
  {
    template: 'packages/cli/src/templates/sign-in-action-tests.ts',
    since: '31.46.0',
    none: "x new's sign-in action tests post the browser form through httpServer and toRoute so the native answer runs (D10); an existing app's tests assert its own landAt redirect, which still holds, so its files stay correct as written",
  },
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
  {
    template: 'packages/cli/src/templates/github/ci.yml.ts',
    since: '31.45.0',
    codemod: 'ci-artifact-retention',
  },
  {
    template: '.github/workflows/ci.yml',
    since: '31.45.0',
    codemod: 'ci-artifact-retention',
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
  {
    template: 'packages/cli/src/templates/shapes/overlay.ts',
    since: '31.47.0',
    none: "the shape overlay's own keyed-record guard became core's isJsonObject (one home, X_HELPER_COPY); it runs inside x new and emits byte-identical files, so an app holds nothing that changed",
  },
  {
    template: 'packages/cli/src/templates/scaffold-suites.ts',
    since: '31.47.1',
    codemod: 'e2e-suite-floor',
  },
  {
    template: 'README.md',
    since: '31.47.0',
    none: "the scaffold's prose now says CI also runs weekly; ci-weekly-schedule carries the behaviour, and an app's own docs are its to edit, so x upgrade leaves them alone",
  },
  {
    template: 'packages/cli/src/templates/scaffold-docs.ts',
    since: '31.47.0',
    none: "the scaffold's prose now says CI also runs weekly; ci-weekly-schedule carries the behaviour, and an app's own docs are its to edit, so x upgrade leaves them alone",
  },
];
