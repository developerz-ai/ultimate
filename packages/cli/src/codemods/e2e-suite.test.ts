// The e2e floor and the suite behind it, read from one answer: an app whose pages sit anywhere but
// `apps/web/site/page.tsx` gets a suite it can run, and a floor never requires one that cannot exist.

import { describe, expect, test } from 'bun:test';
import { E2E_SUITE_PATH, pageE2eSuite } from '../templates/scaffold-suites';
import { floorSteps as scaffoldFloor } from '../templates/scaffold-verify-floor';
import { memoryCodemodApp } from './codemod';
import { codemod as e2eSuiteFloor } from './e2e-suite-floor';
import { runCodemods } from './engine';
import { codemod as testSuites } from './test-suites';
import { codemod as floorSkips } from './verify-floor-skips';
import { codemod as floorSteps } from './verify-floor-steps';

const FLOOR = 'x.verify.json';
const render = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const floorOf = (
  files: Record<string, string>,
): { steps: string[]; skip?: Record<string, string> } => JSON.parse(files[FLOOR] ?? '{}');
const DASHBOARD = 'apps/web/app/dashboard/page.tsx';
const DASHBOARD_SUITE = 'apps/web/app/dashboard/page.e2e.test.ts';
const DYNAMIC = 'apps/web/app/posts/[id]/page.tsx';

describe('unit · an app with pages and no landing page, from an old floor', () => {
  const hop = async (files: Record<string, string>) => {
    const app = memoryCodemodApp({ [FLOOR]: render({ steps: ['typecheck'] }), ...files });
    await runCodemods({
      app,
      codemods: [testSuites, floorSkips, floorSteps, e2eSuiteFloor],
      from: '31.26.0',
      to: '31.47.1',
      dryRun: false,
    });
    return app.files;
  };

  test('app/ pages only: the floor requires e2e and the suite it requires exists', async () => {
    const files = await hop({ [DASHBOARD]: '' });
    expect(floorOf(files).steps).toContain('e2e');
    expect(files[DASHBOARD_SUITE]).toBe(pageE2eSuite('/dashboard'));
    expect(files[E2E_SUITE_PATH]).toBeUndefined();
  });

  test('only parameterised pages: no URL to visit, so e2e is excused and says why', async () => {
    const files = await hop({ [DYNAMIC]: '' });
    expect(floorOf(files).steps).not.toContain('e2e');
    expect(floorOf(files).skip?.['e2e']).toContain('URL parameter');
    expect(Object.keys(files).filter((path) => path.includes('.e2e.test.'))).toEqual([]);
  });

  test('a page in another app workspace is not one the e2e step boots', async () => {
    const files = await hop({ 'apps/admin/app/users/page.tsx': '' });
    expect(floorOf(files).steps).not.toContain('e2e');
    expect(floorOf(files).skip?.['e2e']).toBeDefined();
  });

  test('a suite the app wrote itself is enough: it is required, and nothing is added', async () => {
    const own = 'apps/web/e2e/checkout.e2e.test.ts';
    const files = await hop({ [DYNAMIC]: '', [own]: '// mine\n' });
    expect(floorOf(files).steps).toContain('e2e');
    expect(Object.keys(files).filter((path) => path.includes('.e2e.test.'))).toEqual([own]);
  });
});

describe('unit · verify-floor-steps never requires a suite that cannot exist', () => {
  test('app/ pages with no visitable URL and no suite: e2e stays out of steps', async () => {
    const app = memoryCodemodApp({ [FLOOR]: render({ steps: ['typecheck'] }), [DYNAMIC]: '' });
    await floorSteps.run(app);
    expect(floorOf(app.files).steps).not.toContain('e2e');
  });

  test('a static app/ page is a suite test-suites writes, so e2e is required', async () => {
    const app = memoryCodemodApp({ [FLOOR]: render({ steps: ['typecheck'] }), [DASHBOARD]: '' });
    await floorSteps.run(app);
    expect(floorOf(app.files).steps).toContain('e2e');
  });
});

describe('unit · codemod e2e-suite-floor, an app 31.47.0 left red', () => {
  const required = (extra: Record<string, unknown> = {}) =>
    render({ steps: ['typecheck', 'e2e'], skip: {}, strict: true, ...extra });

  test('the shortest static URL gets the suite, once', async () => {
    const app = memoryCodemodApp({
      [FLOOR]: required(),
      [DASHBOARD]: '',
      'apps/web/app/dashboard/usage/page.tsx': '',
      [DYNAMIC]: '',
    });
    expect(await e2eSuiteFloor.run(app)).toEqual({ changed: [DASHBOARD_SUITE], skipped: [] });
    expect(app.files[FLOOR]).toBe(required());
    expect(await e2eSuiteFloor.run(app)).toEqual({ changed: [], skipped: [] });
  });

  test('the surface root and a route group resolve to the URL the router serves', async () => {
    const root = memoryCodemodApp({ [FLOOR]: required(), 'apps/web/app/page.tsx': '' });
    await e2eSuiteFloor.run(root);
    expect(root.files['apps/web/app/page.e2e.test.ts']).toBe(pageE2eSuite('/'));
    const grouped = memoryCodemodApp({
      [FLOOR]: required(),
      'apps/web/app/(admin)/users/page.tsx': '',
    });
    await e2eSuiteFloor.run(grouped);
    expect(grouped.files['apps/web/app/(admin)/users/page.e2e.test.ts']).toBe(
      pageE2eSuite('/users'),
    );
  });

  test('no page it can visit: e2e moves from steps to skip, so strict stays satisfied', async () => {
    const app = memoryCodemodApp({ [FLOOR]: required(), [DYNAMIC]: '' });
    expect((await e2eSuiteFloor.run(app)).changed).toEqual([FLOOR]);
    const floor = floorOf(app.files);
    expect(floor.steps).toEqual(['typecheck']);
    expect(floor.skip?.['e2e']).toContain('URL parameter');
    expect(await e2eSuiteFloor.run(app)).toEqual({ changed: [], skipped: [] });
  });

  test('an app that excused e2e, or does not require it, is left alone', async () => {
    const excused = render({ steps: ['typecheck'], skip: { e2e: 'mine' } });
    const app = memoryCodemodApp({ [FLOOR]: excused, [DASHBOARD]: '' });
    expect(await e2eSuiteFloor.run(app)).toEqual({ changed: [], skipped: [] });
    expect(app.files).toEqual({ [FLOOR]: excused, [DASHBOARD]: '' });
  });

  test('the excuse for an app with no page at all stays the scaffold’s own', async () => {
    const app = memoryCodemodApp({ [FLOOR]: render({ steps: ['typecheck'] }) });
    await floorSkips.run(app);
    expect(floorOf(app.files).skip?.['e2e']).toBe(
      scaffoldFloor({ jobs: false, pages: false }).skip.e2e,
    );
  });
});

describe('unit · the page suite', () => {
  test('asks the server, so a page behind sign-in passes and a crash does not', () => {
    const suite = pageE2eSuite('/dashboard');
    expect(suite).toContain("await page.goto('/dashboard');");
    expect(suite).toContain('responseStatus');
    expect(suite).toContain('toBeLessThan(500)');
    expect(suite).not.toContain('page.title()');
  });
});
