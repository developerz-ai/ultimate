// Every `X_*` code's REAL `fix:`, read off the throw site that raises it. `x errors explain` used
// to answer `x verify --json` for every code the CLI does not own — 327 of 378 — which is a shrug,
// not an instruction. The framework already writes an executable fix at each throw site and the
// `errors` gate step already proves each one runnable, so the answer is to project that text
// rather than to restate it in a second table nobody keeps current (axiom 2).

// Bun ships no path join: the scan needs an absolute path per globbed, scope-relative entry.
import { join } from 'node:path';
import { staticFix } from './error-contract';
import { frameworkScopeDir } from './framework-scope';
import { isGenerated, isTest, isVendored } from './source-files';
import type { CodeFixSite } from './ts-scan';
import { scanCodeFixSites } from './ts-scan';

/** Every throw site of one code, sorted by file then line so two machines answer identically. */
export type CodeFixIndex = ReadonlyMap<string, readonly CodeFixSite[]>;

/**
 * Published packages ship `src` (`"exports": "./src/index.ts"` — the artifact IS the source), so
 * this glob reaches the same files in `node_modules/@ultimat3` that it reaches in `packages/`.
 */
const PACKAGE_SOURCES = '*/src/**/*.{ts,tsx}';

const byPosition = (a: CodeFixSite, b: CodeFixSite): number =>
  a.at === b.at ? a.line - b.line : a.at.localeCompare(b.at);

/**
 * `x docs`'s `locate()` spelling, deliberately: `@ultimat3/render/src/errors.ts` is the one form
 * that is both a resolvable specifier in an app and an unambiguous file in this monorepo, and two
 * spellings of "where that is" is two things for a reader to learn.
 */
const located = (path: string): string => `@ultimat3/${path}`;

/** One scope directory in, one index out — pure enough for a test to point at a fixture tree. */
export async function scanScopeFixes(scope: string): Promise<CodeFixIndex> {
  const index = new Map<string, CodeFixSite[]>();
  for await (const path of new Bun.Glob(PACKAGE_SOURCES).scan({ cwd: scope, absolute: false })) {
    if (isTest(path) || isGenerated(path) || isVendored(path)) continue;
    const text = await Bun.file(join(scope, path)).text();
    for (const site of scanCodeFixSites(text, located(path))) {
      // `${…}` holds a value only the throw site knows. Blanked to `<value>` — the same shape the
      // `errors` step judges the line in — because a fix quoting a variable name an agent cannot
      // resolve reads as a command it can paste, and it is not one.
      const found: CodeFixSite =
        site.fix === undefined ? site : { ...site, fix: staticFix(site.fix) };
      index.set(site.code, [...(index.get(site.code) ?? []), found]);
    }
  }
  for (const sites of index.values()) sites.sort(byPosition);
  return index;
}

let pending: Promise<CodeFixIndex> | undefined;
let scanned: CodeFixIndex = new Map();

async function build(): Promise<CodeFixIndex> {
  const scope = frameworkScopeDir();
  // A CLI that cannot resolve its own dependency reports that through `x docs`'s finding; here it
  // simply projects nothing, and every code falls back to a line that says so.
  scanned = scope === undefined ? new Map() : await scanScopeFixes(scope);
  return scanned;
}

/**
 * Memoised: one walk of the installed framework per process, for the same reason `loadErrorCatalog`
 * imports every package once. Callers await this before anything reads `codeFixes()`, exactly as
 * they await the catalog before reading `listErrorCodes()` — the seam is synchronous because
 * `@ultimat3/mcp`'s `DevCapabilities.explainError` is.
 */
export function loadCodeFixes(): Promise<CodeFixIndex> {
  pending ??= build();
  return pending;
}

/** What has been loaded, synchronously. Empty until `loadCodeFixes()` has resolved. */
export const codeFixes = (): CodeFixIndex => scanned;

/** Test seam — the counterpart to `resetErrorCatalog`. */
export function resetCodeFixes(): void {
  pending = undefined;
  scanned = new Map();
}
