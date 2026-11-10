// The one production-apps claim and its copies: every negative case is a fixture page, never an
// edit to README.md or the wiki, which other suites read while this one runs.

import { describe, expect, test } from 'bun:test';
import { GENERATED_CLOSE, generatedOpen } from './lib/generated-block';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import {
  checkProductionApps,
  PRODUCTION_APPS,
  PRODUCTION_APPS_FILES,
  PRODUCTION_APPS_FIX,
  productionAppsFindings,
  renderProductionApps,
  writeProductionApps,
} from './production-apps';

const open = generatedOpen('production-apps', PRODUCTION_APPS_FIX);
const page = (body: readonly string[]): string =>
  ['# Page', '', open, ...body, GENERATED_CLOSE, ''].join('\n');

describe('PRODUCTION_APPS', () => {
  test('states a count and never a name: one sentence, no link', () => {
    const [line] = renderProductionApps(PRODUCTION_APPS);
    expect(line).toContain(`${PRODUCTION_APPS.count} apps`);
    expect(line).toContain(PRODUCTION_APPS.sizes);
    expect(line).toContain(`\`As of ${PRODUCTION_APPS.asOf}\``);
    expect(line).not.toMatch(/\]\(|https?:/);
  });

  test('a deployed count above the total is refused at render', () => {
    expect(() => renderProductionApps({ ...PRODUCTION_APPS, deployed: 99 })).toThrow(
      expect.objectContaining({ code: 'X_PRODUCTION_APPS_DRIFT' }),
    );
  });
});

describe('checkProductionApps', () => {
  const rendered = renderProductionApps(PRODUCTION_APPS);

  test('the rendered block is green', () => {
    expect(checkProductionApps('README.md', page(rendered), PRODUCTION_APPS)).toEqual([]);
  });

  test('a hand-edited count reds, naming the file', () => {
    const edited = rendered.map((line) => line.replace(/^\d+ apps/, '12 apps'));
    const [finding] = checkProductionApps('wiki/FAQ.md', page(edited), PRODUCTION_APPS);
    expect(finding?.code).toBe('X_PRODUCTION_APPS_DRIFT');
    expect(finding?.at).toBe('wiki/FAQ.md');
    expect(finding?.fix).toBe(PRODUCTION_APPS_FIX);
  });

  test('a page with no block reds: the copy is the one place the claim may live', () => {
    const [finding] = checkProductionApps('README.md', '# Page\n', PRODUCTION_APPS);
    expect(finding?.code).toBe('X_PRODUCTION_APPS_DRIFT');
    expect(finding?.cause).toContain('no generated production-apps block');
  });

  test('--write repairs the drift it reports', () => {
    const fixed = writeProductionApps(page(['stale']), PRODUCTION_APPS);
    expect(checkProductionApps('README.md', fixed, PRODUCTION_APPS)).toEqual([]);
  });
});

describe('this repository', () => {
  test(
    'README, FAQ and Compared each carry the current claim',
    async () => {
      expect(PRODUCTION_APPS_FILES).toContain('README.md');
      expect(PRODUCTION_APPS_FILES).toContain('wiki/FAQ.md');
      expect(await productionAppsFindings(repoRoot())).toEqual([]);
    },
    REPO_SCAN_TIMEOUT_MS,
  );
});
