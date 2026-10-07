#!/usr/bin/env bun
// Enforce, as a gate rule, that a fenced `ts`/`tsx` example on a `wiki/` page typechecks. The wiki
// is the only public documentation surface and the first code an agent copies from it, and
// `scripts/readme-fences.ts` compiles package READMEs only — every wiki fence was unchecked.
//
// Same machinery (`scripts/lib/readme-fences.ts`: one module per fence, the repo's own `tsc`, two
// passes because a syntax error anywhere silences every semantic diagnostic), and the same RATCHET:
// `scripts/wiki-fences-backlog.ts` pins today's failures per FENCE (page plus first code line), and
// a row may only fall — so a fixed example cannot be traded for a new broken one on the same page.
//
//   bun run scripts/wiki-fences.ts [--json] [--pin]

import { flagBool, parseScriptArgs } from './lib/args';
import { loweredRows, siteTally } from './lib/fence-sites';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import type { Fence } from './lib/readme-fences';
import { buildFixtures, compileFixtures, isSyntactic, readFences } from './lib/readme-fences';
import { repoRoot } from './lib/run';
import type { FenceFailure, FenceGap } from './readme-fences';
import { checkFences, failuresFrom } from './readme-fences';
import { WIKI_FENCE_BACKLOG } from './wiki-fences-backlog';

const SCRIPT = 'wiki-fences';
export const WIKI_FENCE_GLOB = 'wiki/*.md';
export const WIKI_BACKLOG_FILE = 'scripts/wiki-fences-backlog.ts';

/** `wiki/Error-Codes.md` → `Error-Codes`: the page name, which is also how the wiki links it. */
export const pageOf = (path: string): string =>
  (path.split('/').at(-1) ?? path).replace(/\.md$/, '');

const pagePath = (page: string): string => `wiki/${page}.md`;

/** Every `ts`/`tsx` fence on every wiki page, keyed by page name, pages in sorted order. */
export async function readWikiFences(root: string): Promise<readonly Fence[]> {
  const paths: string[] = [];
  for await (const path of new Bun.Glob(WIKI_FENCE_GLOB).scan({ cwd: root, absolute: false })) {
    paths.push(path.replaceAll('\\', '/'));
  }
  const fences: Fence[] = [];
  for (const path of paths.sort()) {
    fences.push(...readFences(pageOf(path), await Bun.file(`${root}/${path}`).text()));
  }
  return fences;
}

export interface WikiFenceMeasure {
  readonly pages: readonly string[];
  readonly failures: readonly FenceFailure[];
  readonly unscanned?: string;
}

/**
 * Compile, drop what will not PARSE, compile again — `scripts/readme-fences.ts`' `fenceFailures`
 * over the wiki's fences. Two passes are enough: one fixture is one fence, so removing an
 * unparseable one cannot make another unparseable.
 */
export async function wikiFenceFailures(root: string): Promise<WikiFenceMeasure> {
  const fences = await readWikiFences(root);
  const pages = [...new Set(fences.map((fence) => fence.pkg))].sort();
  if (fences.length === 0) return { pages: [], failures: [] };
  const all = buildFixtures(fences);
  const one = await compileFixtures(root, all);
  if (one.failure !== undefined) return { pages, failures: [], unscanned: one.failure };
  const unparseable = failuresFrom(all, one.diagnostics.filter(isSyntactic));
  if (unparseable.length === 0) return { pages, failures: failuresFrom(all, one.diagnostics) };
  const broken = new Set(unparseable.map((fail) => `${fail.pkg}:${fail.readmeLine}`));
  const rest = buildFixtures(fences, (fence) => broken.has(`${fence.pkg}:${fence.readmeLine}`));
  const two = await compileFixtures(root, rest);
  if (two.failure !== undefined) return { pages, failures: unparseable, unscanned: two.failure };
  return { pages, failures: [...unparseable, ...failuresFrom(rest, two.diagnostics)] };
}

/** The ratchet's verdict: `readme-fences`' pure comparator, keyed by page instead of package. */
export const checkWikiFences = (
  measured: WikiFenceMeasure,
  backlog: Readonly<Record<string, number>> = WIKI_FENCE_BACKLOG,
): readonly FenceGap[] =>
  checkFences({
    packages: measured.pages,
    failures: measured.failures,
    backlog,
    ...(measured.unscanned === undefined && measured.pages.length > 0
      ? {}
      : { unscanned: measured.unscanned ?? 'no wiki page carries a fenced ts or tsx example' }),
  });

export function wikiFenceFinding(gap: FenceGap): Finding {
  if (gap.kind === 'unscanned') {
    return {
      code: 'X_WIKI_EXAMPLE_UNSCANNED',
      cause: `${gap.detail ?? ''}, so this rule reported green over wiki examples it never compiled`,
      fix: "bun install, then bun run scripts/wiki-fences.ts --json — the compiler is the repo's own node_modules/.bin/tsc and the inputs are wiki/*.md",
      at: WIKI_BACKLOG_FILE,
    };
  }
  if (gap.kind === 'stale') {
    return {
      code: 'X_WIKI_EXAMPLE_PIN_STALE',
      cause: `${WIKI_BACKLOG_FILE} pins ${gap.pinned} failing example(s) at '${gap.site}' on ${pagePath(gap.pkg)} and ${gap.failing} fail now — a ratchet that does not tighten is a ratchet nobody reads`,
      fix: 'bun run scripts/wiki-fences.ts --pin',
      at: WIKI_BACKLOG_FILE,
    };
  }
  const first = gap.failures[0];
  const lines = gap.failures.map((one) => one.readmeLine).join(', ');
  return {
    code: 'X_WIKI_EXAMPLE_UNCOMPILED',
    cause: `${gap.failures.length} fenced example(s) in ${pagePath(gap.pkg)} opening \`${gap.site.slice(gap.pkg.length + 2)}\` do not typecheck and ${gap.pinned} are pinned — failing at line(s) ${lines}; the first says: ${first?.reason ?? ''}`,
    fix: `bun run scripts/wiki-fences.ts --json   # then make the fence at ${pagePath(gap.pkg)}:${first?.readmeLine ?? 0} compile, or pin its row in ${WIKI_BACKLOG_FILE} at ${gap.failures.length} on purpose, with a // why:`,
    at: `${pagePath(gap.pkg)}:${first?.readmeLine ?? 0}`,
  };
}

/** What this repo contributes to `x verify`'s `manifest` step. */
export async function wikiFenceFindings(root: string): Promise<readonly Finding[]> {
  return checkWikiFences(await wikiFenceFailures(root)).map(wikiFenceFinding);
}

/** `--pin`: lower each row to what is measured; never raise one — that is a reviewed edit. */
export function pinnedWikiSource(
  measured: Readonly<Record<string, number>>,
  backlog: Readonly<Record<string, number>>,
  source: string,
): string {
  return source.replace(
    /(export const WIKI_FENCE_BACKLOG: Readonly<Record<string, number>> = \{\n)[\s\S]*?(\n\};)/,
    (_whole, open: string, close: string) => `${open}${loweredRows(measured, backlog)}${close}`,
  );
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const measured = await wikiFenceFailures(root);
  const gaps = checkWikiFences(measured);
  if (flagBool(args, 'pin')) {
    const path = `${root}/${WIKI_BACKLOG_FILE}`;
    const text = await Bun.file(path).text();
    await Bun.write(path, pinnedWikiSource(siteTally(measured.failures), WIKI_FENCE_BACKLOG, text));
  }
  const total = measured.failures.length;
  report(
    {
      ok: gaps.length === 0,
      script: SCRIPT,
      summary:
        gaps.length === 0
          ? `${measured.pages.length} wiki pages, ${total} fenced example(s) failing, every one pinned`
          : `${gaps.length} wiki fence site(s) off the ratchet (${total} failing)`,
      findings: gaps.map(wikiFenceFinding),
      data: { failures: measured.failures },
    },
    args.json,
  );
}
