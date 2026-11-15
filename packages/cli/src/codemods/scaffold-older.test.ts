// The codemods that carry a 31.4.0 – 31.18.0 scaffold: run in order, as a hop from 31.4.0 runs
// them, over files as that scaffold wrote them, they give back today's bytes and then nothing.
// Two whole-file forms (the one-job ci.yml, the pre-burn-rate alert rules) are matched exactly.

import { describe, expect, test } from 'bun:test';
import { names } from '../templates';
import { githubFiles } from '../templates/github/ci.yml';
import { helmMonitoringFiles } from '../templates/scaffold-helm-alerts';
import { codemod as agentsDevMcp } from './agents-dev-mcp';
import { codemod as biome } from './biome-no-default-export';
import { codemod as bunfig } from './bunfig-island-coverage';
import { codemod as ciE2e } from './ci-e2e-browser';
import { CI_31_15_LINES } from './ci-e2e-browser-stock';
import { memoryCodemodApp } from './codemod';
import { codemod as defineErrorLeaf } from './define-error-leaf';
import { codemod as docsCiParts } from './docs-ci-parts';
import { codemod as docsGate } from './docs-gate-prose';
import { codemod as docsIslandRows } from './docs-island-rows';
import { codemod as docsGuards } from './docs-shipped-guards';
import { codemod as docsTests } from './docs-test-services';
import { runCodemods } from './engine';
import { codemod as helmAlerts } from './helm-alerts-objective';
import { ALERT_RULES_31_15_LINES } from './helm-alerts-stock';
import { codemod as metrics } from './metrics-probe-healthz';
import { before314, today } from './scaffold-prose-fixture';
import { codemod as themeToggle } from './theme-toggle-mount-over';

const CODEMODS = [
  defineErrorLeaf,
  biome,
  docsIslandRows,
  themeToggle,
  docsCiParts,
  helmAlerts,
  agentsDevMcp,
  docsGate,
  metrics,
  bunfig,
  ciE2e,
  docsTests,
  docsGuards,
];

const hop = (files: Record<string, string>) =>
  runCodemods({
    app: memoryCodemodApp(files),
    codemods: CODEMODS,
    from: '31.4.0',
    to: '31.28.0',
    dryRun: false,
  });

describe('unit · the codemods that carry a 31.4.0 scaffold', () => {
  test('every touched file comes back as x new writes it today, and a rerun changes nothing', async () => {
    const files = before314();
    expect(files['packages/domain/src/index.ts']).toContain("from '@ultimat3/core';");
    const app = memoryCodemodApp(files);
    const run = (from: string) =>
      runCodemods({ app, codemods: CODEMODS, from, to: '31.28.0', dryRun: false });
    expect((await run('31.4.0')).applied.flatMap((one) => one.skipped)).toEqual([]);
    for (const path of Object.keys(today))
      expect([path, app.files[path]]).toEqual([path, today[path]]);
    const again = await run('0.0.0');
    expect(
      again.applied.flatMap((one) => [...one.changed, ...one.skipped.map((s) => s.path)]),
    ).toEqual([]);
  });

  test('a default export anywhere holds noDefaultExport back, with the files and the diff', async () => {
    const files = { ...before314(), 'apps/web/x.ts': 'export default 1;\n' };
    const report = await hop(files);
    const skip = report.applied.find((one) => one.id === 'biome-no-default-export')?.skipped[0];
    expect(skip?.reason).toContain('apps/web/x.ts');
    expect(skip?.diff).toContain(
      '+      "style": { "useNodejsImportProtocol": "error", "noDefaultExport": "error" }',
    );
  });
});

describe('unit · the theme toggle', () => {
  test('a toggle whose mount the app already rewrote is its own: no import added, nothing said', async () => {
    const path = 'apps/web/shared/theme-toggle.island.tsx';
    const mine = String(today[path])
      .replace('mountOver(el,', 'myMount(el,')
      .replace("import { mountOver } from '@ultimat3/render/client';\n", '');
    const app = memoryCodemodApp({ [path]: mine });
    expect(await themeToggle.run(app)).toEqual({ changed: [], skipped: [] });
  });
});

describe('unit · the whole-file forms', () => {
  const PACKAGE = `${JSON.stringify({ name: 'shop' })}\n`;

  test('the one-job ci.yml of 31.4–31.15, whatever its bun-version, becomes today’s', async () => {
    const old = CI_31_15_LINES.map((line) => line.replace('<APP>', 'shop'))
      .join('\n')
      .replace(/bun-version: '[^']*'/g, "bun-version: '1.3.0'");
    const app = memoryCodemodApp({ 'package.json': PACKAGE, '.github/workflows/ci.yml': old });
    expect((await ciE2e.run(app)).changed).toEqual(['.github/workflows/ci.yml']);
    expect(app.files['.github/workflows/ci.yml']).toBe(
      String(
        githubFiles(names('shop')).find((f) => f.path === '.github/workflows/ci.yml')?.contents,
      ),
    );
  });

  test('a one-job ci.yml with one line of its own is the app’s, and reported', async () => {
    const old = `${CI_31_15_LINES.map((line) => line.replace('<APP>', 'shop')).join('\n')}# mine\n`;
    const app = memoryCodemodApp({ 'package.json': PACKAGE, '.github/workflows/ci.yml': old });
    const result = await ciE2e.run(app);
    expect(result.skipped.map((skip) => skip.path)).toEqual(['.github/workflows/ci.yml']);
    expect(app.files['.github/workflows/ci.yml']).toBe(old);
  });

  test('the pre-31.18 alert rules, still exactly so, become today’s; edited ones stay', async () => {
    const RULES = 'docker/helm/templates/alert-rules.yaml';
    const old = ALERT_RULES_31_15_LINES.map((line) => line.replaceAll('<APP>', 'shop')).join('\n');
    const app = memoryCodemodApp({ 'docker/helm/Chart.yaml': 'name: shop\n', [RULES]: old });
    expect((await helmAlerts.run(app)).changed).toEqual([RULES]);
    expect(app.files[RULES]).toBe(
      String(helmMonitoringFiles(names('shop')).find((f) => f.path === RULES)?.contents),
    );
    const edited = memoryCodemodApp({
      'docker/helm/Chart.yaml': 'name: shop\n',
      [RULES]: `${old}# mine\n`,
    });
    expect((await helmAlerts.run(edited)).changed).toEqual([]);
  });
});
