// The scaffold as an older `x new` wrote it, for the prose and config codemods' tests: today's
// output (`x new fxapp`, the example slice on), each codemod's own edits run backwards in turn.
// The real 31.4.0 / 31.15.0 / 31.20.0 / 31.22.0 scaffolds were checked against it by hand.

import { expect } from 'bun:test';
import { names } from '../templates';
import { appFiles } from '../templates/scaffold-app';
import { SHIPPED_GUARD_NAMES } from '../templates/scaffold-guards';
import { repoFiles } from '../templates/scaffold-repo';
import { AGENT_TOOLS } from './agents-dev-mcp';
import { BIOME_EDITS } from './biome-no-default-export';
import { BUNFIG_EDITS } from './bunfig-island-coverage';
import { CI_E2E_EDITS } from './ci-e2e-browser';
import { CI_SERVICES_ENV_EDITS } from './ci-services-env';
import { DEFINE_ERROR_PROSE } from './define-error-leaf';
import { DOCS_CI_PARTS_EDITS } from './docs-ci-parts';
import { DOCS_GATE_EDITS } from './docs-gate-prose';
import { DOCS_ISLAND_EDITS } from './docs-island-rows';
import { SHIPPED_GUARDS_EDITS } from './docs-shipped-guards';
import { DOCS_TEST_SERVICES_EDITS } from './docs-test-services';
import type { SnippetEdit } from './engine-edits';
import { HELM_VALUES_EDITS } from './helm-alerts-objective';
import { METRICS_PROBE_EDITS } from './metrics-probe-healthz';
import { THEME_TOGGLE_EDITS } from './theme-toggle-mount-over';

export const today: Record<string, string> = {};
for (const file of [
  ...repoFiles(names('fxapp'), '31.28.0', true),
  ...appFiles(names('fxapp'), true),
]) {
  if (typeof file.contents === 'string') today[file.path] = file.contents;
}

export const undo = (text: string, edits: readonly SnippetEdit[]): string => {
  let out = text;
  for (const edit of [...edits].reverse()) {
    expect(out).toContain(edit.to);
    out = out.replace(edit.to, () => edit.from);
  }
  return out;
};

// "Today" is what these tests' hops end at, 31.28.0: a codemod after it — none of theirs — undone.
const CI = '.github/workflows/ci.yml';
today[CI] = undo(today[CI] ?? '', CI_SERVICES_ENV_EDITS);

/** Every touched file as the 31.20.0 scaffold wrote it: today's, each later codemod undone in turn. */
export function before(): Record<string, string> {
  const files = { ...today };
  const at = (path: string): string => files[path] ?? '';
  for (const [path, edits] of Object.entries(SHIPPED_GUARDS_EDITS))
    files[path] = undo(at(path), edits);
  files['CLAUDE.md'] = at('CLAUDE.md')
    .split('\n')
    .map((line) =>
      line.startsWith('| ')
        ? line.replace(/`([a-z0-9-]+)`/g, (cell, name: string) =>
            SHIPPED_GUARD_NAMES.includes(name) ? `\`guards/${name}.ts\`` : cell,
          )
        : line,
    )
    .join('\n');
  for (const [path, edits] of Object.entries(DOCS_TEST_SERVICES_EDITS))
    files[path] = undo(at(path), edits);
  files['.github/workflows/ci.yml'] = undo(at('.github/workflows/ci.yml'), CI_E2E_EDITS);
  files['bunfig.toml'] = undo(at('bunfig.toml'), BUNFIG_EDITS);
  for (const [path, edits] of Object.entries(METRICS_PROBE_EDITS))
    files[path] = undo(at(path), edits);
  files['CLAUDE.md'] = undo(at('CLAUDE.md'), DOCS_GATE_EDITS);
  for (const [path, tools] of Object.entries(AGENT_TOOLS)) {
    files[path] = at(path).replace(`\n${tools}, mcp__fxapp__*\n`, `\n${tools}\n`);
  }
  return files;
}

const DOMAIN = 'packages/domain/src/index.ts';
const POST_ERRORS = 'apps/web/app/post/errors.ts';

/** The same files as 31.4.0 wrote them: `before()`, then each 31.4.1–31.18.0 codemod undone. */
export function before314(): Record<string, string> {
  const files = before();
  const at = (path: string): string => files[path] ?? '';
  files['docker/helm/values.yaml'] = undo(at('docker/helm/values.yaml'), HELM_VALUES_EDITS);
  for (const [path, edits] of Object.entries(DOCS_CI_PARTS_EDITS))
    files[path] = undo(at(path), edits);
  files['CLAUDE.md'] = undo(at('CLAUDE.md'), DOCS_ISLAND_EDITS);
  const toggle = 'apps/web/shared/theme-toggle.island.tsx';
  files[toggle] = undo(at(toggle), THEME_TOGGLE_EDITS);
  files['biome.json'] = undo(at('biome.json'), BIOME_EDITS);
  for (const [path, edits] of Object.entries(DEFINE_ERROR_PROSE))
    files[path] = undo(at(path), edits);
  for (const path of [DOMAIN, POST_ERRORS]) {
    files[path] = at(path).replace("from '@ultimat3/core/page';", "from '@ultimat3/core';");
  }
  return files;
}
