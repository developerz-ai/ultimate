#!/usr/bin/env bun
// Enforce, on `x verify`'s `manifest` step, the npm page of every publishable package: its README's
// first screen holds one sentence, an install line, the smallest example and the package's wiki
// page (its `homepage`), and its `package.json` carries `keywords`. Measured 2026-11-02: no package
// had keywords, every homepage was `#readme`, and `@ultimat3/core`'s page opened on a module table.
//
//   bun run scripts/package-front.ts [--json]

// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { renderFixShellArg } from '@ultimat3/core';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { listWorkspaces, readWorkspaceManifest } from './lib/workspaces';

/** One screen of npm's README panel, and the budget the four parts must fit in. */
export const FRONT_LINES = 30;
export const WIKI_ROOT = 'https://github.com/developerz-ai/ultimate/wiki';
export const PINS_FILE = 'scripts/package-front.ts';

/**
 * Packages whose first screen may miss a part, with the reason. Shrink-only: a package that passes
 * is reported until its row goes. Empty since the slice that added the rule burned it down.
 */
export const README_SHAPE_PINS: Readonly<Record<string, string>> = {};

export type FrontPart = 'heading' | 'sentence' | 'install' | 'example' | 'wiki';

export interface FrontPackage {
  readonly dir: string;
  readonly name: string;
  readonly readme: string;
  /** The parsed `package.json`, unchecked — the two fields read here are checked where read. */
  readonly manifest: Readonly<Record<string, unknown>>;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const FENCE = /^\s*```/;

/** `bun add [-d] <name>` or `bunx <name>`, the name whole — `@ultimat3/moneyx` is not money. */
const installPattern = (name: string): RegExp =>
  new RegExp(`(?:\\bbun add(?: -d)?|\\bbunx) ${escapeRegExp(name)}(?![\\w/-])`);

/** A line that is ONLY the install, at most one argument (`bunx create-ultimate myapp`). */
const installOnlyPattern = (name: string): RegExp =>
  new RegExp(`^\\s*(?:bun add(?: -d)?|bunx) ${escapeRegExp(name)}(?:\\s+[\\w.-]+)?\\s*$`);

const homepageOf = (manifest: FrontPackage['manifest']): string | undefined => {
  const value = manifest['homepage'];
  return typeof value === 'string' && value.startsWith(`${WIKI_ROOT}`) ? value : undefined;
};

/** The parts of the first screen that are missing, in reading order. Pure over the text. */
export function checkReadmeShape(pkg: FrontPackage): readonly FrontPart[] {
  const lines = pkg.readme.split('\n').slice(0, FRONT_LINES);
  const missing: FrontPart[] = [];
  // An emoji may sit beside the name (`# 🧱 @ultimat3/core`); the name itself must be a whole word.
  const heading = lines[0] ?? '';
  if (!/^# /.test(heading) || !heading.split(/\s+/).includes(pkg.name)) missing.push('heading');
  const first = lines.slice(1).find((line) => line.trim() !== '') ?? '';
  if (/^\s*(?:[|#<>-]|```)/.test(first)) missing.push('sentence');
  const install = installPattern(pkg.name);
  if (!lines.some((line) => install.test(line))) missing.push('install');
  if (!hasExample(lines, installOnlyPattern(pkg.name))) missing.push('example');
  const home = homepageOf(pkg.manifest);
  if (home === undefined || !lines.some((line) => line.includes(home))) missing.push('wiki');
  return missing;
}

/**
 * A fence that opens on the first screen and shows, on that screen, a line that is not the install
 * command. It need not close there: npm renders the rest, and a reader already sees the shape.
 */
function hasExample(lines: readonly string[], installOnly: RegExp): boolean {
  let inside = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      inside = !inside;
      continue;
    }
    if (inside && line.trim() !== '' && !installOnly.test(line)) return true;
  }
  return false;
}

export const checkKeywords = (manifest: Readonly<Record<string, unknown>>): boolean => {
  const keywords = manifest['keywords'];
  return (
    Array.isArray(keywords) &&
    keywords.length > 0 &&
    keywords.every((word) => typeof word === 'string' && word.trim() !== '')
  );
};

const PART_TEXT: Readonly<Record<FrontPart, string>> = {
  heading: 'a first line "# <package name>", an emoji beside it allowed',
  sentence: 'one sentence of prose under the heading',
  install: 'an install line (bun add <package name>)',
  example: 'a code fence with the smallest example',
  wiki: 'a link to its package.json homepage, a page under the wiki',
};

/** Findings for one package, with the pins applied. Pure, so pins are fixtures too. */
export function frontFindingsFor(
  pkg: FrontPackage,
  pins: Readonly<Record<string, string>>,
): readonly Finding[] {
  const readmePath = `packages/${pkg.dir}/README.md`;
  const manifestPath = `packages/${pkg.dir}/package.json`;
  const findings: Finding[] = [];
  const missing = checkReadmeShape(pkg);
  const pinned = Object.hasOwn(pins, pkg.dir);
  if (missing.length > 0 && !pinned) {
    findings.push({
      code: 'X_PACKAGE_README_SHAPE',
      cause: `${readmePath}'s first ${FRONT_LINES} lines lack ${missing.map((part) => PART_TEXT[part]).join('; ')} — the npm page of ${pkg.name} opens on them`,
      fix: `grep -n '^#' ${renderFixShellArg(readmePath, '<README.md>')}   # put ${missing.map((part) => PART_TEXT[part]).join(', ')} in its first ${FRONT_LINES} lines, internal tables below — or pin ${pkg.dir} with a reason in README_SHAPE_PINS in ${PINS_FILE}`,
      at: readmePath,
    });
  }
  if (missing.length === 0 && pinned) {
    findings.push({
      code: 'X_PACKAGE_README_SHAPE',
      cause: `${readmePath} now passes, and README_SHAPE_PINS still exempts ${pkg.dir} — a pin that exempts nothing hides the next regression`,
      fix: `grep -n README_SHAPE_PINS scripts/package-front.ts   # delete its ${pkg.dir} row`,
      at: PINS_FILE,
    });
  }
  if (!checkKeywords(pkg.manifest)) {
    findings.push({
      code: 'X_PACKAGE_KEYWORDS_MISSING',
      cause: `${manifestPath} has no non-empty "keywords" array, so npm search never offers ${pkg.name}`,
      fix: `grep -n '"name"' ${renderFixShellArg(manifestPath, '<package.json>')}   # add "keywords": ["ultimate", "bun", …] beside it, naming what the package does`,
      at: manifestPath,
    });
  }
  return findings;
}

/** Every publishable workspace, read. A package with no README reads as an empty one: all missing. */
export async function readFrontPackages(root: string): Promise<readonly FrontPackage[]> {
  const out: FrontPackage[] = [];
  for (const workspace of await listWorkspaces(root)) {
    if (workspace.private) continue;
    const read = await readWorkspaceManifest(join(workspace.path, 'package.json'));
    const manifest = read.kind === 'read' ? (read.manifest as Record<string, unknown>) : {};
    const readme = Bun.file(join(workspace.path, 'README.md'));
    out.push({
      dir: workspace.dir,
      name: workspace.name,
      readme: (await readme.exists()) ? await readme.text() : '',
      manifest,
    });
  }
  return out;
}

/** A pin naming no publishable package exempts nothing, and would hide the package's return. */
export function unknownPinFindings(
  known: ReadonlySet<string>,
  pins: Readonly<Record<string, string>>,
): readonly Finding[] {
  return Object.keys(pins)
    .filter((dir) => !known.has(dir))
    .map((dir) => ({
      code: 'X_PACKAGE_README_SHAPE',
      cause: `README_SHAPE_PINS exempts ${dir}, which is no publishable package`,
      fix: `grep -n README_SHAPE_PINS scripts/package-front.ts   # delete its ${dir} row`,
      at: PINS_FILE,
    }));
}

export async function packageFrontFindings(root: string): Promise<readonly Finding[]> {
  const packages = await readFrontPackages(root);
  return [
    ...packages.flatMap((pkg) => frontFindingsFor(pkg, README_SHAPE_PINS)),
    ...unknownPinFindings(new Set(packages.map((pkg) => pkg.dir)), README_SHAPE_PINS),
  ];
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const findings = await packageFrontFindings(repoRoot());
  report(
    {
      ok: findings.length === 0,
      script: 'package-front',
      summary:
        findings.length === 0
          ? 'every publishable package opens its npm page on a sentence, an install, an example and its wiki page, with keywords'
          : `${findings.length} npm-page finding(s)`,
      findings,
    },
    args.json,
  );
}
