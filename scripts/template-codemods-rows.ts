// The answer `scripts/template-codemods.ts` asks of every scaffold-owned template a release
// changes: the codemod that carries an app across (`packages/cli/src/codemods/<id>.ts`, listed in
// `codemods/index.ts` with the same `since`), or the written reason no app needs one. One row per
// template per release; a row at or below the last release tag is history and binds nothing.

import { TEMPLATE_CODEMOD_ROWS_31_40 } from './template-codemods-rows-31.40';

export type TemplateCodemodRow =
  | { readonly template: string; readonly since: string; readonly codemod: string }
  | { readonly template: string; readonly since: string; readonly none: string };

export const TEMPLATE_CODEMOD_ROWS: readonly TemplateCodemodRow[] = [
  // Written after the release they carry: history, kept so each template names its codemod.
  {
    template: 'packages/cli/src/templates/scaffold-domain-package.ts',
    since: '31.4.1',
    codemod: 'define-error-leaf',
  },
  {
    template: 'packages/cli/src/templates/slice-foundation.ts',
    since: '31.4.1',
    codemod: 'define-error-leaf',
  },
  {
    template: 'packages/cli/src/templates/scaffold-claude-agents.ts',
    since: '31.4.1',
    codemod: 'define-error-leaf',
  },
  {
    template: 'packages/cli/src/templates/scaffold-claude-commands.ts',
    since: '31.4.1',
    codemod: 'define-error-leaf',
  },
  {
    template: 'packages/cli/src/templates/scaffold-repo.ts',
    since: '31.6.0',
    codemod: 'biome-no-default-export',
  },
  {
    template: 'packages/cli/src/templates/scaffold-docs.ts',
    since: '31.15.0',
    codemod: 'docs-island-rows',
  },
  {
    template: 'packages/cli/src/templates/scaffold-shell.ts',
    since: '31.15.0',
    codemod: 'theme-toggle-mount-over',
  },
  {
    template: 'packages/cli/src/templates/scaffold-docs.ts',
    since: '31.17.0',
    codemod: 'docs-ci-parts',
  },
  {
    template: 'packages/cli/src/templates/scaffold-claude-commands.ts',
    since: '31.17.0',
    codemod: 'docs-ci-parts',
  },
  {
    template: 'packages/cli/src/templates/scaffold-helm-alerts.ts',
    since: '31.18.0',
    codemod: 'helm-alerts-objective',
  },
  {
    template: 'packages/cli/src/templates/scaffold-helm.ts',
    since: '31.18.0',
    codemod: 'helm-alerts-objective',
  },
  {
    template: 'packages/cli/src/templates/scaffold-docs.ts',
    since: '31.22.0',
    codemod: 'docs-gate-prose',
  },
  {
    template: 'packages/cli/src/templates/scaffold-claude-agents.ts',
    since: '31.22.0',
    codemod: 'agents-dev-mcp',
  },
  {
    template: 'packages/cli/src/templates/scaffold-container-compose.ts',
    since: '31.25.0',
    codemod: 'metrics-probe-healthz',
  },
  {
    template: 'packages/cli/src/templates/scaffold-helm-templates.ts',
    since: '31.25.0',
    codemod: 'metrics-probe-healthz',
  },
  {
    template: 'packages/cli/src/templates/scaffold-repo.ts',
    since: '31.27.0',
    codemod: 'bunfig-island-coverage',
  },
  {
    template: 'packages/cli/src/templates/github/ci.yml.ts',
    since: '31.27.0',
    codemod: 'ci-e2e-browser',
  },
  {
    template: 'packages/cli/src/templates/scaffold-docs.ts',
    since: '31.27.0',
    codemod: 'docs-test-services',
  },
  {
    template: 'packages/cli/src/templates/scaffold-suites.ts',
    since: '31.27.0',
    codemod: 'test-suites',
  },
  {
    template: 'packages/cli/src/templates/scaffold-test-services.ts',
    since: '31.27.0',
    codemod: 'test-ports',
  },
  {
    template: 'packages/cli/src/templates/scaffold-verify-floor.ts',
    since: '31.27.0',
    codemod: 'verify-floor-skips',
  },
  {
    template: 'packages/cli/src/templates/scaffold-guards.ts',
    since: '31.28.0',
    codemod: 'vendored-guards',
  },
  {
    template: 'packages/cli/src/templates/scaffold-docs.ts',
    since: '31.28.0',
    none: 'docs text only: AGENTS.md names each shipped guard, not a guards/<name>.ts file a new app no longer holds; the vendored-guards migration covers existing apps',
  },
  {
    template: 'packages/cli/src/templates/scaffold-claude-agents.ts',
    since: '31.28.0',
    none: 'docs text only: CLAUDE.md names the error-declared guard, not its guards/ file; the vendored-guards migration covers existing apps',
  },
  {
    template: 'packages/cli/src/templates/github/ci.yml.ts',
    since: '31.28.0',
    codemod: 'runtime-pin',
  },
  {
    template: 'packages/cli/src/templates/bun-image.ts',
    since: '31.28.0',
    codemod: 'runtime-pin',
  },
  {
    template: 'packages/cli/src/templates/scaffold-repo.ts',
    since: '31.28.0',
    codemod: 'solid-floor',
  },
  {
    template: 'packages/cli/src/templates/scaffold-repo.ts',
    since: '31.28.0',
    codemod: 'repro-gitignore',
  },
  {
    template: 'packages/cli/src/templates/scaffold-docs.ts',
    since: '31.28.0',
    codemod: 'docs-shipped-guards',
  },
  {
    template: 'packages/cli/src/templates/scaffold-claude-agents.ts',
    since: '31.28.0',
    codemod: 'docs-shipped-guards',
  },
  {
    template: 'packages/cli/src/templates/scaffold-verify-floor.ts',
    since: '31.28.0',
    codemod: 'verify-floor-steps',
  },
  {
    template: 'packages/cli/src/templates/scaffold-claude-hook.ts',
    since: '31.28.0',
    codemod: 'format-edited-hook',
  },
  {
    template: 'packages/cli/src/templates/scaffold-claude.ts',
    since: '31.28.0',
    codemod: 'format-edited-hook',
  },
  {
    template: 'packages/cli/src/templates/scaffold-claude-agents.ts',
    since: '31.28.0',
    codemod: 'format-edited-hook',
  },
  {
    template: 'packages/cli/src/templates/scaffold-claude-commands.ts',
    since: '31.28.0',
    codemod: 'format-edited-hook',
  },
  {
    template: 'docker/helm/templates/alert-rules.yaml',
    since: '31.29.0',
    codemod: 'helm-alerts-deploy',
  },
  {
    template: 'docker/helm/dashboards/ultimate-app.json',
    since: '31.29.0',
    codemod: 'helm-alerts-deploy',
  },
  {
    template: 'packages/cli/src/templates/scaffold-helm-alerts.ts',
    since: '31.29.0',
    codemod: 'helm-alerts-deploy',
  },
  {
    template: 'packages/cli/src/templates/scaffold-helm-alert-rules.ts',
    since: '31.29.0',
    codemod: 'helm-alerts-deploy',
  },
  {
    template: 'packages/cli/src/templates/scaffold-helm-alert-deploy.ts',
    since: '31.29.0',
    codemod: 'helm-alerts-deploy',
  },
  {
    template: 'packages/cli/src/templates/chart-dashboard.ts',
    since: '31.29.0',
    codemod: 'helm-alerts-deploy',
  },
  {
    template: 'packages/cli/src/templates/chart-dashboard-panels.ts',
    since: '31.29.0',
    codemod: 'helm-alerts-deploy',
  },
  {
    template: 'packages/cli/src/templates/scaffold-helm-migrate.ts',
    since: '31.29.0',
    codemod: 'migrate-job-ordered',
  },
  {
    template: 'packages/cli/src/templates/scaffold-helm-templates.ts',
    since: '31.29.0',
    codemod: 'migrate-job-ordered',
  },
  {
    template: 'packages/cli/src/templates/scaffold-container.ts',
    since: '31.29.0',
    codemod: 'migrate-job-ordered',
  },
  {
    template: 'docker/helm/templates/migrate-job.yaml',
    since: '31.29.0',
    codemod: 'migrate-job-ordered',
  },
  {
    template: 'packages/cli/src/templates/scaffold-helm.ts',
    since: '31.29.0',
    codemod: 'migrate-job-ordered',
  },
  {
    template: 'docker/helm/values.yaml',
    since: '31.29.0',
    codemod: 'migrate-job-ordered',
  },
  {
    template: 'docker/README.md',
    since: '31.29.0',
    codemod: 'migrate-job-ordered',
  },
  {
    template: 'biome.json',
    since: '31.32.0',
    none: 'the formatter pin only: `$schema` is an editor hint and the app keeps the `@biomejs/biome` it installed, so an app left on 2.6.3 is not broken by this repository moving to 2.6.4',
  },
  {
    template: 'package.json',
    since: '31.32.0',
    none: 'the same formatter pin in `devDependencies`: the app keeps the Biome version it installed, which still lints its tree, so the hop changes nothing an app runs',
  },
  {
    template: 'packages/cli/src/templates/scaffold-repo.ts',
    since: '31.32.0',
    none: 'it renders the pin the two rows above carry: a new app gets 2.6.4 and an existing one keeps its own Biome, so no separate codemod moves an app file',
  },
  {
    template: 'packages/cli/src/templates/island.ts',
    since: '31.33.0',
    none: "the generator trims its --dir argument with core's trimTrailingSlashes instead of /\\/+$/; the island file it writes is byte-identical, so no app holds anything to migrate",
  },
  {
    template: 'packages/cli/src/templates/shapes/agent-actions.ts',
    since: '31.38.0',
    none: "a new shape's overlay (plan 101b sweep 9): only `x new --shape <it>` renders it, and no app was made with a shape that did not exist at the last release, so none holds anything to migrate",
  },
  {
    template: 'packages/cli/src/templates/shapes/agent-job.ts',
    since: '31.38.0',
    none: "a new shape's overlay (plan 101b sweep 9): only `x new --shape <it>` renders it, and no app was made with a shape that did not exist at the last release, so none holds anything to migrate",
  },
  {
    template: 'packages/cli/src/templates/shapes/agent-model.ts',
    since: '31.38.0',
    none: "a new shape's overlay (plan 101b sweep 9): only `x new --shape <it>` renders it, and no app was made with a shape that did not exist at the last release, so none holds anything to migrate",
  },
  {
    template: 'packages/cli/src/templates/shapes/agent-prompt.ts',
    since: '31.38.0',
    none: "a new shape's overlay (plan 101b sweep 9): only `x new --shape <it>` renders it, and no app was made with a shape that did not exist at the last release, so none holds anything to migrate",
  },
  {
    template: 'packages/cli/src/templates/shapes/agent-scripted.ts',
    since: '31.38.0',
    none: "a new shape's overlay (plan 101b sweep 9): only `x new --shape <it>` renders it, and no app was made with a shape that did not exist at the last release, so none holds anything to migrate",
  },
  {
    template: 'packages/cli/src/templates/shapes/agent.ts',
    since: '31.38.0',
    none: "a new shape's overlay (plan 101b sweep 9): only `x new --shape <it>` renders it, and no app was made with a shape that did not exist at the last release, so none holds anything to migrate",
  },
  {
    template: 'packages/cli/src/templates/shapes/content-admin-es.ts',
    since: '31.38.0',
    none: "a new shape's overlay (plan 101b sweep 9): only `x new --shape <it>` renders it, and no app was made with a shape that did not exist at the last release, so none holds anything to migrate",
  },
  {
    template: 'packages/cli/src/templates/shapes/content-pages.ts',
    since: '31.38.0',
    none: "a new shape's overlay (plan 101b sweep 9): only `x new --shape <it>` renders it, and no app was made with a shape that did not exist at the last release, so none holds anything to migrate",
  },
  {
    template: 'packages/cli/src/templates/shapes/content-site.ts',
    since: '31.38.0',
    none: "a new shape's overlay (plan 101b sweep 9): only `x new --shape <it>` renders it, and no app was made with a shape that did not exist at the last release, so none holds anything to migrate",
  },
  {
    template: 'packages/cli/src/templates/shapes/content.ts',
    since: '31.38.0',
    none: "a new shape's overlay (plan 101b sweep 9): only `x new --shape <it>` renders it, and no app was made with a shape that did not exist at the last release, so none holds anything to migrate",
  },
  {
    template: 'packages/cli/src/templates/shapes/index.ts',
    since: '31.38.0',
    none: "the shape table gains five rows; it decides what `x new --shape` writes, never an app's existing files",
  },
  {
    template: 'packages/cli/src/templates/shapes/offline-e2e.ts',
    since: '31.38.0',
    none: "a new shape's overlay (plan 101b sweep 9): only `x new --shape <it>` renders it, and no app was made with a shape that did not exist at the last release, so none holds anything to migrate",
  },
  {
    template: 'packages/cli/src/templates/shapes/offline-form.ts',
    since: '31.38.0',
    none: "a new shape's overlay (plan 101b sweep 9): only `x new --shape <it>` renders it, and no app was made with a shape that did not exist at the last release, so none holds anything to migrate",
  },
  {
    template: 'packages/cli/src/templates/shapes/offline.ts',
    since: '31.38.0',
    none: "a new shape's overlay (plan 101b sweep 9): only `x new --shape <it>` renders it, and no app was made with a shape that did not exist at the last release, so none holds anything to migrate",
  },
  {
    template: 'packages/cli/src/templates/shapes/realtime-mutator.ts',
    since: '31.38.0',
    none: "a new shape's overlay (plan 101b sweep 9): only `x new --shape <it>` renders it, and no app was made with a shape that did not exist at the last release, so none holds anything to migrate",
  },
  {
    template: 'packages/cli/src/templates/shapes/realtime-nodes.ts',
    since: '31.38.0',
    none: "a new shape's overlay (plan 101b sweep 9): only `x new --shape <it>` renders it, and no app was made with a shape that did not exist at the last release, so none holds anything to migrate",
  },
  {
    template: 'packages/cli/src/templates/shapes/realtime-slice.ts',
    since: '31.38.0',
    none: "a new shape's overlay (plan 101b sweep 9): only `x new --shape <it>` renders it, and no app was made with a shape that did not exist at the last release, so none holds anything to migrate",
  },
  {
    template: 'packages/cli/src/templates/shapes/realtime.ts',
    since: '31.38.0',
    none: "a new shape's overlay (plan 101b sweep 9): only `x new --shape <it>` renders it, and no app was made with a shape that did not exist at the last release, so none holds anything to migrate",
  },
  {
    template: 'packages/cli/src/templates/shapes/saas-billing-tests.ts',
    since: '31.38.0',
    none: "a new shape's overlay (plan 101b sweep 9): only `x new --shape <it>` renders it, and no app was made with a shape that did not exist at the last release, so none holds anything to migrate",
  },
  {
    template: 'packages/cli/src/templates/shapes/saas-billing.ts',
    since: '31.38.0',
    none: "a new shape's overlay (plan 101b sweep 9): only `x new --shape <it>` renders it, and no app was made with a shape that did not exist at the last release, so none holds anything to migrate",
  },
  {
    template: 'packages/cli/src/templates/shapes/saas-receiver.ts',
    since: '31.38.0',
    none: "a new shape's overlay (plan 101b sweep 9): only `x new --shape <it>` renders it, and no app was made with a shape that did not exist at the last release, so none holds anything to migrate",
  },
  {
    template: 'packages/cli/src/templates/shapes/saas.ts',
    since: '31.38.0',
    none: "a new shape's overlay (plan 101b sweep 9): only `x new --shape <it>` renders it, and no app was made with a shape that did not exist at the last release, so none holds anything to migrate",
  },
  {
    template: 'packages/cli/src/templates/sign-in-oidc.ts',
    since: '31.38.0',
    none: 'imports OIDC_RUNTIME_ROUTES from sign-in-runtime.ts instead of declaring it; what `x g sign-in --oidc` writes is byte-identical',
  },
  {
    template: 'packages/cli/src/templates/sign-in-runtime.ts',
    since: '31.38.0',
    none: '`x g sign-in` now splices its guard into an edited runtime.ts instead of refusing; on an untouched scaffold it writes byte-identical bytes, and an app that already ran it holds the same files',
  },
  {
    template: 'packages/cli/src/templates/sign-in-shared.ts',
    since: '31.38.0',
    none: "the runtime templates moved to sign-in-runtime.ts with their output unchanged; an app's sign-in files are byte-identical",
  },
  {
    template: 'biome.json',
    since: '31.41.0',
    none: 'the merge updates only the `$schema` editor hint; an existing app keeps its installed Biome and its own config remains valid, so no codemod moves an app file',
  },
  {
    template: 'package.json',
    since: '31.41.0',
    none: "the root `@biomejs/biome` pin moves to 2.6.4 and every @ultimat3/* is written exact (D9), what x upgrade writes and x doctor's X_FRAMEWORK_PIN_RANGE asks for; an existing app retains its Biome, and its caret is moved exact by its next x upgrade hop, while x doctor names the line and the version",
  },
  {
    template: 'packages/cli/src/templates/scaffold-repo.ts',
    since: '31.41.0',
    none: 'x new now writes the 2.6.4 Biome pin and schema URL and every @ultimat3/* exact (D9); an existing app retains its valid Biome config, while its caret is moved exact by its next x upgrade hop and x doctor names the line and the version until then',
  },
  ...TEMPLATE_CODEMOD_ROWS_31_40,
];
