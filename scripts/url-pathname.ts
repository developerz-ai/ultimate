#!/usr/bin/env bun

// Enforce that no source reads `.pathname` off a URL built from `import.meta.url` as a filesystem path.
//
// `URL.pathname` is a URL's path, not the host's: it percent-encodes a space (a checkout under
// `My Projects` became `My%20Projects`, a directory that does not exist) and on Windows answers
// `/C:/Users/…`, which no API there opens. `repoRoot()` was built that way and fed every gate script,
// so on either machine `bun run verify` could not find the repository it was verifying. Plan 101
// sweep 8a (W5) replaced every site with `Bun.fileURLToPath(new URL(…))` or `join(import.meta.dir, …)`.
//
// WHAT COUNTS: `new URL(…, import.meta.url)` — or `new URL(import.meta.url)` — followed by
// `.pathname`, and a `const`/`let` bound to one and later read as `<name>.pathname` in the same file.
// Strings count as well as code: a template that emits the shape into an app hands every app the
// bug. Comments do not — naming the removed shape cannot run. An HTTP URL's `pathname` is a route,
// and is never read here: only a URL resolved against the module's own location is a file.
//
// ZERO-PINNED: the sweep finished before the rule landed, so it holds no table and enforces outright.
//
//   bun run url-pathname  ·  bun run scripts/url-pathname.ts [--json]

import { stripComments } from '../packages/core/src/source-mask';
import { parseScriptArgs } from './lib/args';
import { corpus } from './lib/corpus';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { lineOf } from './lib/source-scan';

const SCRIPT = 'url-pathname';

/** This rule's own test spells the refused shape as fixtures; every other file is read. */
export const SELF_TEST = 'scripts/url-pathname.test.ts';

/** The tracked apps, which `corpus('source')` does not read: an app inherits whatever we ship. */
const APP_GLOBS = ['examples/**/*.{ts,tsx}', 'dummy/**/*.{ts,tsx}'] as const;
const NOT_SOURCE = /(?:^|\/)(?:node_modules|dist|\.x)\//;

const MODULE_URL = 'import.meta.url';
const OPEN = /\bnew\s+URL\s*\(/g;
const BINDING = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?:\s*:\s*URL)?\s*=\s*$/;
const PATHNAME = /^\s*\.\s*pathname\b/;

export interface UrlPathnameSite {
  readonly path: string;
  readonly line: number;
}

/**
 * The offset just past the `)` closing the call opened at `from` (just past its `(`), or -1. Quotes
 * are skipped whole so a `)` inside a specifier string is not the close; a backslash escapes.
 */
function closeOf(text: string, from: number): number {
  let depth = 1;
  let quote = '';
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    if (quote !== '') {
      if (char === '\\') at += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }
  return -1;
}

/** Every `.pathname` read off a module-relative URL in one file, by line. */
export function scanUrlPathname(path: string, source: string): readonly UrlPathnameSite[] {
  const text = stripComments(source);
  const offsets: number[] = [];
  const names = new Set<string>();
  for (const open of text.matchAll(OPEN)) {
    const start = open.index + open[0].length;
    const end = closeOf(text, start);
    if (end === -1 || !text.slice(start, end).includes(MODULE_URL)) continue;
    if (PATHNAME.test(text.slice(end))) offsets.push(open.index);
    const bound = BINDING.exec(text.slice(Math.max(0, open.index - 120), open.index))?.[1];
    if (bound !== undefined) names.add(bound);
  }
  for (const name of names) {
    const read = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\.\\s*pathname\\b`, 'g');
    for (const match of text.matchAll(read)) offsets.push(match.index);
  }
  return offsets.sort((a, b) => a - b).map((at) => ({ path, line: lineOf(source, at) }));
}

export const urlPathnameFindingFor = (site: UrlPathnameSite): Finding => ({
  code: 'X_URL_PATHNAME_AS_PATH',
  cause: `${site.path}:${String(site.line)} reads .pathname off a URL built from import.meta.url and uses it as a filesystem path — it percent-encodes a space (%20) and answers /C:/… on Windows, so the path names nothing`,
  fix: `Bun.fileURLToPath(new URL('<specifier>', import.meta.url)) in place of the .pathname read at ${site.path}:${String(site.line)} — or join(import.meta.dir, '<segment>', …) from node:path`,
  at: `${site.path}:${String(site.line)}`,
});

/** The framework's `source` corpus (floor-checked) plus the two tracked apps. */
export async function urlPathnameSites(root: string): Promise<{
  readonly sites: readonly UrlPathnameSite[];
  readonly files: readonly string[];
}> {
  const files = new Map<string, string>();
  for (const file of await corpus(root, 'source')) files.set(file.path, file.source);
  for (const glob of APP_GLOBS) {
    for (const found of new Bun.Glob(glob).scanSync({ cwd: root })) {
      const path = found.split('\\').join('/');
      if (NOT_SOURCE.test(path) || files.has(path)) continue;
      files.set(path, await Bun.file(`${root}/${path}`).text());
    }
  }
  const paths = [...files.keys()].filter((path) => path !== SELF_TEST).sort();
  const sites = paths.flatMap((path) => scanUrlPathname(path, files.get(path) ?? ''));
  return { sites, files: paths };
}

/** What this rule contributes to `x verify`'s `unit` step, through `url-pathname.test.ts`. */
export const urlPathnameFindings = async (root: string): Promise<readonly Finding[]> =>
  (await urlPathnameSites(root)).sites.map(urlPathnameFindingFor);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const findings = await urlPathnameFindings(repoRoot());
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? 'no module URL is read as a filesystem path through .pathname'
          : `${String(findings.length)} module URL(s) read as a filesystem path through .pathname`,
      findings,
    },
    args.json,
  );
}
