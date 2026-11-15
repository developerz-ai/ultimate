// The scaffold's prose and config codemods (31.22.0 → 31.28.0), run in order as a hop runs them
// over files as the older scaffold wrote them — each template edit run backwards from what `x new`
// writes today — must give back today's bytes exactly, and a second run must change nothing.
// Checked by hand against the real 31.15.0 / 31.20.0 / 31.22.0 scaffolds as well (W7's cache).

import { describe, expect, test } from 'bun:test';
import { names } from '../templates';
import { appFiles } from '../templates/scaffold-app';
import { SHIPPED_GUARD_NAMES } from '../templates/scaffold-guards';
import { repoFiles } from '../templates/scaffold-repo';
import { AGENT_TOOLS, codemod as agentsDevMcp } from './agents-dev-mcp';
import { BUNFIG_EDITS, codemod as bunfig } from './bunfig-island-coverage';
import { CI_E2E_EDITS, codemod as ciE2e } from './ci-e2e-browser';
import { memoryCodemodApp } from './codemod';
import { DOCS_GATE_EDITS, codemod as docsGate } from './docs-gate-prose';
import { codemod as docsGuards, SHIPPED_GUARDS_EDITS } from './docs-shipped-guards';
import { DOCS_TEST_SERVICES_EDITS, codemod as docsTests } from './docs-test-services';
import { runCodemods } from './engine';
import type { SnippetEdit } from './engine-edits';
import { METRICS_PROBE_EDITS, codemod as metrics } from './metrics-probe-healthz';

const CODEMODS = [agentsDevMcp, docsGate, metrics, bunfig, ciE2e, docsTests, docsGuards];

const today: Record<string, string> = {};
for (const file of [
  ...repoFiles(names('fxapp'), '31.28.0', true),
  ...appFiles(names('fxapp'), true),
]) {
  if (typeof file.contents === 'string') today[file.path] = file.contents;
}

const undo = (text: string, edits: readonly SnippetEdit[]): string => {
  let out = text;
  for (const edit of [...edits].reverse()) {
    expect(out).toContain(edit.to);
    out = out.replace(edit.to, () => edit.from);
  }
  return out;
};

/** Every touched file as the 31.20.0 scaffold wrote it: today's, each later codemod undone in turn. */
function before(): Record<string, string> {
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

describe('unit · the scaffold prose and config codemods, 31.20.0 → 31.28.0', () => {
  test('a Runtime row the app already placed elsewhere is not added twice', async () => {
    const files = before();
    const claude = files['CLAUDE.md'] ?? '';
    files['CLAUDE.md'] = `${claude}\n| Runtime | mine | \`runtime-pin\` |\n`;
    const app = memoryCodemodApp(files);
    await docsGuards.run(app);
    expect(app.files['CLAUDE.md']?.match(/^\| Runtime \|/gm)).toHaveLength(1);
  });

  test('every touched file comes back as x new writes it today', async () => {
    const old = before();
    expect(old['CLAUDE.md']).toContain('`guards/raw-fetch.ts`');
    expect(old['bunfig.toml']).toContain('coveragePathIgnorePatterns');
    const app = memoryCodemodApp(old);
    const report = await runCodemods({
      app,
      codemods: CODEMODS,
      from: '31.20.0',
      to: '31.28.0',
      dryRun: false,
    });
    expect(report.applied.flatMap((one) => one.skipped)).toEqual([]);
    for (const path of Object.keys(today))
      expect([path, app.files[path]]).toEqual([path, today[path]]);
    const again = await runCodemods({
      app,
      codemods: CODEMODS,
      from: '0.0.0',
      to: '31.28.0',
      dryRun: false,
    });
    expect(
      again.applied.flatMap((one) => [...one.changed, ...one.skipped.map((s) => s.path)]),
    ).toEqual([]);
  });

  test('a workflow the app rewrote is reported with the diff; reworded prose is left silently', async () => {
    const files = before();
    files['.github/workflows/ci.yml'] = 'name: mine\n';
    files['CLAUDE.md'] = '# mine\n';
    const app = memoryCodemodApp(files);
    const report = await runCodemods({
      app,
      codemods: CODEMODS,
      from: '31.20.0',
      to: '31.28.0',
      dryRun: false,
    });
    expect(report.applied.flatMap((one) => one.skipped.map((skip) => skip.path))).toEqual([
      '.github/workflows/ci.yml',
    ]);
    expect(app.files['CLAUDE.md']).toBe('# mine\n');
  });
});
