// The bytes a budget never charges to the app: the service worker registration and the inlined
// theme boot are the framework's, reported as `frameworkBytes` and never as the route's `jsBytes`.
// Split from `budgets.test.ts` at the 500-line ceiling — one subject, what the measurer exempts.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import type { RouteFact } from '@ultimat3/manifest';
import { buildManifest } from '@ultimat3/manifest';
import { themeScriptBody } from '@ultimat3/render';
import type { BuildStats } from './budgets';
import { checkBudgets, FRAMEWORK_SCRIPTS, measureDocumentJs } from './budgets';
import { processRoot } from './process-root-fixture';
import type { PwaArtifacts } from './pwa-artifacts';
import { SW_REGISTER_PATH, serviceWorkerHead } from './sw-artifacts';

const manifestOf = (...routes: readonly RouteFact[]) =>
  buildManifest({ app: { name: 'fixture', version: '1.0.0' }, routes });

const route = (url: string, budget?: RouteFact['budget']): RouteFact => ({
  url,
  render: 'static',
  ...(budget === undefined ? {} : { budget }),
});

const stats = (...routes: BuildStats['routes']): BuildStats => ({ routes });

const jsBytesOf = async (html: string, out: string): Promise<number> =>
  (await measureDocumentJs(html, out)).jsBytes;

// -------------------------------------------------------------------------------------------
// `budget.js` is a promise about the APP's JavaScript. The framework injects its own service
// worker registration into EVERY document it renders (`sw-artifacts.ts`'s `serviceWorkerHead`,
// 250 bytes), and charging those bytes to the route made `js: '0kb'` unreachable for any
// installable app — which contradicts what `site/` promises and what `x new` scaffolds.
//
// Measured on a real scaffold, 2026-09-11, and the SECOND face of the defect is worse than the
// first: `/x-sw-register.js` is written AFTER the documents are measured, so build #1 weighed a
// file that did not exist yet and recorded `jsBytes: 0`, and build #2 weighed the one build #1
// left behind and recorded `jsBytes: 250` — the same commit, green then red, decided by whether
// `.x/` had been cleaned. A gate whose verdict depends on run order is not a gate.
// -------------------------------------------------------------------------------------------
describe("unit · the framework-injected runtime is not the app's JS", () => {
  const root = processRoot(join(tmpdir(), 'x-budget-framework'));
  const registration = '<script src="/x-sw-register.js" defer></script>';

  /** An installable app, as `loadPwaArtifacts` resolves one. `fallback` is what emits the tag. */
  const PWA: PwaArtifacts = {
    body: '{}',
    head: '',
    manifests: [],
    headFor: () => '',
    offline: {
      fallback: '/offline',
      image: null,
      font: null,
      neverCache: [],
      personalPages: 'never',
    },
    backgroundSync: false,
    push: false,
  };

  const withRegistration = async (): Promise<string> => {
    const dir = join(root, `case-${Bun.hash('sw-register').toString(16)}`);
    await Bun.write(join(dir, 'x-sw-register.js'), 'r'.repeat(250));
    return dir;
  };

  test('the path excluded is the one sw-artifacts.ts emits, not a literal typed twice', () => {
    expect([...FRAMEWORK_SCRIPTS]).toEqual([SW_REGISTER_PATH]);
    expect(serviceWorkerHead(PWA)).toBe(`<script src="${SW_REGISTER_PATH}" defer></script>`);
  });

  test("its bytes are not the route's jsBytes", async () => {
    expect(await jsBytesOf(registration, await withRegistration())).toBe(0);
  });

  // Reported, never folded in silently: the bytes exist and a reader is owed the number.
  test('they are reported under their own name instead', async () => {
    const measured = await measureDocumentJs(registration, await withRegistration());
    expect(measured.frameworkBytes).toBe(250);
  });

  // `heaviestChain` named `/x-sw-register.js` as the app's heaviest import on every route of a
  // fresh scaffold — a `fix:` pointing at a file the author did not write and cannot remove.
  test('and it is not an entry, so no finding can name it as the heaviest import', async () => {
    expect((await measureDocumentJs(registration, await withRegistration())).entries).toEqual([]);
  });

  // The app's own scripts are untouched by the exclusion — the half that would make this a hole.
  test('an app script in the same document is still charged in full', async () => {
    const dir = join(root, `case-${Bun.hash('sw-plus-app').toString(16)}`);
    await Bun.write(join(dir, 'x-sw-register.js'), 'r'.repeat(250));
    await Bun.write(join(dir, 'app.js'), 'console.log(1)');
    const measured = await measureDocumentJs(
      `${registration}<script type="module" src="/app.js"></script>`,
      dir,
    );
    expect(measured.jsBytes).toBe(14);
    expect(measured.frameworkBytes).toBe(250);
    expect(measured.entries).toEqual([{ url: '/app.js', bytes: 14 }]);
  });

  // The gate's end of it: the row a build now writes for a `site/` page of an installable app.
  test('a 0kb route carrying only the registration passes the gate', () => {
    const findings = checkBudgets(
      manifestOf(route('/', { js: '0kb' })),
      stats({ path: '/', jsBytes: 0, frameworkJsBytes: 250 }),
    );
    expect(findings).toEqual([]);
  });

  // And the app's own bytes still fail it, or the exclusion has eaten the gate.
  test("the same route still fails on one byte of the app's own JS", () => {
    const findings = checkBudgets(
      manifestOf(route('/', { js: '0kb' })),
      stats({ path: '/', jsBytes: 1, frameworkJsBytes: 250 }),
    );
    expect(findings.map((finding) => finding.code)).toEqual(['X_BUDGET_EXCEEDED']);
  });
});

describe('the theme boot is counted, never charged', () => {
  // No `src` anywhere in these documents, so the output directory is never read.
  const out = tmpdir();

  test('a 0kb site page carrying only the inlined theme script ships 0 bytes of its own JS', async () => {
    for (const fallback of ['light', 'dark', 'system'] as const) {
      const html = `<!doctype html><html><head><script>${themeScriptBody({ fallback })}</script></head><body></body></html>`;
      const measured = await measureDocumentJs(html, out);
      expect(measured.jsBytes).toBe(0);
      expect(measured.frameworkBytes).toBeGreaterThan(0);
    }
  });

  test("a body that merely resembles it — a key the boot never uses — is the app's own script", async () => {
    const custom = themeScriptBody({ fallback: 'dark', storageKey: 'my-theme' });
    const own = await measureDocumentJs(`<script>${custom}</script>`, out);
    expect(own.jsBytes).toBe(Buffer.byteLength(custom, 'utf8'));
    expect(own.frameworkBytes).toBe(0);
  });
});
