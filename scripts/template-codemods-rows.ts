// The answer `scripts/template-codemods.ts` asks of every scaffold-owned template a release
// changes: the codemod that carries an app across (`packages/cli/src/codemods/<id>.ts`, listed in
// `codemods/index.ts` with the same `since`), or the written reason no app needs one. One row per
// template per release; a row at or below the last release tag is history and binds nothing.

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
    template: 'packages/cli/src/templates/query.ts',
    since: '31.40.0',
    none: "a generated query no longer declares `mcp: { expose: true, description: '<name> — edit this description' }` (D5); an app's existing query is the author's, its tool line theirs to keep or describe, and nothing reads a query differently without it; its emitted test's no-agent title names no query, so it fits Biome's width at any name — a test title an existing app keeps or renames",
  },
  {
    template: 'apps/web/app/post/live/post-list.ts',
    since: '31.40.0',
    none: "the scaffold's live read no longer exposes an MCP tool under a placeholder description (D5); an app's copy is the author's, and its tool keeps working until they describe or drop it",
  },
  {
    template: '.github/workflows/ci.yml',
    since: '31.40.0',
    codemod: 'ci-services-env',
  },
  {
    template: 'packages/cli/src/templates/github/ci.yml.ts',
    since: '31.40.0',
    codemod: 'ci-services-env',
  },
  {
    template: 'apps/web/app/post/live/post-list.live.test.ts',
    since: '31.40.0',
    none: "its tool assertion now pins no MCP tool, matching the read that no longer declares one (D5); an app's copy pins the tool its own post-list.ts still declares, so the two stay in agreement untouched",
  },
  {
    template: 'packages/cli/src/templates/shapes/saas.ts',
    since: '31.40.0',
    none: "only `x new --shape saas` renders it, at scaffold time: `@ultimat3/flags` is now written exact like every @ultimat3/* (D9), and an existing app's range is x upgrade's to move, never this overlay's",
  },
  {
    template: 'CLAUDE.md',
    since: '31.40.0',
    codemod: 'docs-env-guard',
  },
  {
    template: 'AGENTS.md',
    since: '31.40.0',
    codemod: 'docs-env-guard',
  },
  {
    template: 'packages/cli/src/templates/scaffold-docs.ts',
    since: '31.40.0',
    codemod: 'docs-env-guard',
  },
  {
    template: 'packages/cli/src/templates/scaffold-guards.ts',
    since: '31.40.0',
    none: 'a new shipped guard, undeclared-env (D8), runs built in from the installed CLI; scaffoldGuardFiles() still writes only guards/shipped.json, byte-identical, so no app holds anything to migrate',
  },
  {
    template: 'package.json',
    since: '31.40.0',
    none: "every @ultimat3/* is written exact (D9), what x upgrade writes and x doctor's X_FRAMEWORK_PIN_RANGE asks for; an existing app's caret is moved exact by its next x upgrade hop, and until then x doctor names the line and the version",
  },
  {
    template: 'packages/i18n/package.json',
    since: '31.40.0',
    none: "every @ultimat3/* is written exact (D9), what x upgrade writes and x doctor's X_FRAMEWORK_PIN_RANGE asks for; an existing app's caret is moved exact by its next x upgrade hop, and until then x doctor names the line and the version",
  },
  {
    template: 'packages/cli/src/templates/scaffold-repo.ts',
    since: '31.40.0',
    none: "every @ultimat3/* is written exact (D9), what x upgrade writes and x doctor's X_FRAMEWORK_PIN_RANGE asks for; an existing app's caret is moved exact by its next x upgrade hop, and until then x doctor names the line and the version",
  },
  {
    template: 'packages/cli/src/templates/scaffold-i18n.ts',
    since: '31.40.0',
    none: "every @ultimat3/* is written exact (D9), what x upgrade writes and x doctor's X_FRAMEWORK_PIN_RANGE asks for; an existing app's caret is moved exact by its next x upgrade hop, and until then x doctor names the line and the version",
  },
  {
    template: 'packages/cli/src/templates/shapes/agent.ts',
    since: '31.40.0',
    none: "only `x new --shape agent` renders it, at scaffold time: `@ultimat3/ai` is now written exact like every @ultimat3/* (D9), and an existing app's range is x upgrade's to move, never this overlay's",
  },
  {
    template: 'packages/cli/src/templates/shapes/offline.ts',
    since: '31.40.0',
    none: "only `x new --shape offline` renders it, at scaffold time: `@ultimat3/realtime` is now written exact like every @ultimat3/* (D9), and an existing app's range is x upgrade's to move, never this overlay's",
  },
  {
    template: 'packages/cli/src/templates/shapes/realtime.ts',
    since: '31.40.0',
    none: "only `x new --shape realtime` renders it, at scaffold time: `@ultimat3/notify` and `@ultimat3/realtime` are now written exact like every @ultimat3/* (D9), and an existing app's range is x upgrade's to move, never this overlay's",
  },
  {
    template: 'README.md',
    since: '31.40.0',
    none: "only `x new --shape saas` renders the changed sentence (its description, shortened to keep the scaffold's AGENTS.md under its 12,000 B budget once the undeclared-env row landed); an existing app's README is its own prose",
  },
  {
    template: 'packages/cli/src/templates/policy.ts',
    since: '31.40.0',
    none: 'the emitted policy.ts is byte-identical: its write rule moved into the exported ORG_WRITE_RULE constant, which grantOf reads back',
  },
  {
    template: 'packages/cli/src/templates/slice-foundation.ts',
    since: '31.40.0',
    none: "grantOf now reads x g policy's own org write rule, so a later x g action into that slice writes its handler test; no file an app already holds changes",
  },
  {
    template: 'packages/cli/src/templates/action.ts',
    since: '31.40.0',
    none: "only x g action/mutator renders it, into a slice whose write rule is x g policy's own: the generated test now asserts the handler and its exercise binds the org; files an app already holds are unchanged",
  },
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
];
