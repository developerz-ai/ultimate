// The scaffold's prose and config codemods (31.22.0 → 31.28.0), run in order as a hop runs them
// over files as the older scaffold wrote them — each template edit run backwards from what `x new`
// writes today — must give back today's bytes exactly, and a second run must change nothing.
// Checked by hand against the real 31.15.0 / 31.20.0 / 31.22.0 scaffolds as well (W7's cache).

import { describe, expect, test } from 'bun:test';
import { codemod as agentsDevMcp } from './agents-dev-mcp';
import { codemod as bunfig } from './bunfig-island-coverage';
import { codemod as ciE2e } from './ci-e2e-browser';
import { memoryCodemodApp } from './codemod';
import { codemod as docsGate } from './docs-gate-prose';
import { codemod as docsGuards } from './docs-shipped-guards';
import { codemod as docsTests } from './docs-test-services';
import { runCodemods } from './engine';
import { codemod as metrics } from './metrics-probe-healthz';
import { before, today } from './scaffold-prose-fixture';

const CODEMODS = [agentsDevMcp, docsGate, metrics, bunfig, ciE2e, docsTests, docsGuards];

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
