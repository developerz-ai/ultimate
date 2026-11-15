// The answer `scripts/template-codemods.ts` asks of every scaffold-owned template a release
// changes: the codemod that carries an app across (`packages/cli/src/codemods/<id>.ts`, listed in
// `codemods/index.ts` with the same `since`), or the written reason no app needs one. One row per
// template per release; a row at or below the last release tag is history and binds nothing.

export type TemplateCodemodRow =
  | { readonly template: string; readonly since: string; readonly codemod: string }
  | { readonly template: string; readonly since: string; readonly none: string };

export const TEMPLATE_CODEMOD_ROWS: readonly TemplateCodemodRow[] = [
  // 31.27.0, written after its tag: history, kept so each template names the codemod carrying it.
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
];
