// The answer `scripts/template-codemods.ts` asks of every scaffold-owned template a release
// changes: the codemod that carries an app across (`packages/cli/src/codemods/<id>.ts`, listed in
// `codemods/index.ts` with the same `since`), or the written reason no app needs one. One row per
// template per release; a row at or below the last release tag is history and binds nothing.
import { TEMPLATE_CODEMOD_HISTORY } from './template-codemods-rows-history';

export type TemplateCodemodRow =
  | { readonly template: string; readonly since: string; readonly codemod: string }
  | { readonly template: string; readonly since: string; readonly none: string };

export const TEMPLATE_CODEMOD_ROWS: readonly TemplateCodemodRow[] = [
  ...TEMPLATE_CODEMOD_HISTORY,
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
