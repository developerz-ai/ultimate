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

describe('unit · config files of the app’s own', () => {
  test('a biome.json not shaped as x new wrote it (a monorepo child) is the app’s: nothing said', async () => {
    const child =
      '{\n  "extends": "//",\n  "linter": { "rules": { "style": { "useNodejsImportProtocol": "error" } } }\n}\n';
    expect(await biome.run(memoryCodemodApp({ 'biome.json': child }))).toEqual({
      changed: [],
      skipped: [],
    });
  });

  test('a reworded compose comment still has its probe moved to /healthz', async () => {
    const stock = String(before314()['docker/docker-compose.prod.yml']);
    const reworded = stock.replace(
      'exactly as they do in `docker/helm`.',
      'exactly as they do in the Helm chart.',
    );
    const app = memoryCodemodApp({ 'docker/docker-compose.prod.yml': reworded });
    expect((await metrics.run(app)).changed).toEqual(['docker/docker-compose.prod.yml']);
    expect(app.files['docker/docker-compose.prod.yml']).toContain("+'/healthz')");
    expect(app.files['docker/docker-compose.prod.yml']).toContain('in the Helm chart.');
  });
});

describe('unit · bunfig.toml', () => {
  const ROW = 'coveragePathIgnorePatterns = ["**/*.mjs"]';

  test('an app with its own preload, or the stock file with no last newline: never a hand step', async () => {
    const own = memoryCodemodApp({ 'bunfig.toml': '[test]\npreload = ["./mine.ts"]\n' });
    expect(await bunfig.run(own)).toEqual({ changed: [], skipped: [] });
    const stock = String(before314()['bunfig.toml']).trimEnd();
    expect(stock.endsWith(ROW)).toBe(true);
    const app = memoryCodemodApp({ 'bunfig.toml': stock });
    expect((await bunfig.run(app)).changed).toEqual(['bunfig.toml']);
    expect(app.files['bunfig.toml']).not.toContain(ROW);
    expect(await bunfig.run(app)).toEqual({ changed: [], skipped: [] });
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

describe('unit · the whole-file forms, on a Windows checkout', () => {
  const crlf = (text: string): string => `\uFEFF${text.replaceAll('\n', '\r\n')}`;

  test('a CRLF one-job ci.yml with a BOM is still recognised, and keeps both', async () => {
    const old = CI_31_15_LINES.map((line) => line.replace('<APP>', 'shop')).join('\n');
    const app = memoryCodemodApp({
      'package.json': `${JSON.stringify({ name: 'shop' })}\n`,
      '.github/workflows/ci.yml': crlf(old),
    });
    expect((await ciE2e.run(app)).changed).toEqual(['.github/workflows/ci.yml']);
    const today = String(
      githubFiles(names('shop')).find((f) => f.path === '.github/workflows/ci.yml')?.contents,
    );
    expect(app.files['.github/workflows/ci.yml']).toBe(crlf(today));
  });

  test('CRLF pre-31.18 alert rules are still recognised, and keep CRLF', async () => {
    const RULES = 'docker/helm/templates/alert-rules.yaml';
    const old = ALERT_RULES_31_15_LINES.map((line) => line.replaceAll('<APP>', 'shop')).join('\n');
    const app = memoryCodemodApp({
      'docker/helm/Chart.yaml': 'name: shop\r\n',
      [RULES]: crlf(old),
    });
    expect((await helmAlerts.run(app)).changed).toEqual([RULES]);
    expect(app.files[RULES]).toBe(
      crlf(String(helmMonitoringFiles(names('shop')).find((f) => f.path === RULES)?.contents)),
    );
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
    const result = await helmAlerts.run(edited);
    expect(result.changed).toEqual([]);
    // Said, not silent: the template's own change, as a diff to make by hand.
    expect(result.skipped.map((skip) => skip.path)).toEqual([RULES]);
    expect(result.skipped[0]?.diff).toContain('objective');
    // Today's own file is no hand step at all.
    const now = memoryCodemodApp({
      'docker/helm/Chart.yaml': 'name: shop\n',
      [RULES]: String(app.files[RULES]),
    });
    expect(await helmAlerts.run(now)).toEqual({ changed: [], skipped: [] });
  });
});
