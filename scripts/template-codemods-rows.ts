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
];
