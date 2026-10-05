#!/usr/bin/env bun
// Enforce, as a gate rule, that every `packages/…`, `scripts/…` or `docs/…` path a published page
// names in backticks exists in this tree, unless the page says it is history.
//
// The gap this closes: 22.0.0 renamed the CLI's `dev-*` boot modules to `runtime-*`, and eight
// package CLAUDE.md files kept sending their reader to `dev-cache.ts`, `dev-queue.ts`, `dev-storage.ts`
// — files that no longer exist — while `docs/architecture/10-cross-cutting.md` quoted a
// `packages/ui/src/tokens.ts` that never existed at all. A page naming a file is an instruction to
// open it, and nothing checked the instruction.
//
// WHAT IS READ. Inline code spans, outside fences. Inside a fence, only a file-header comment —
// a line that is nothing but `//`, `/*`, `#` or `--` and a path — because that line claims where
// the block lives; every other fenced line is program text or a transcript of an app's tree.
// A path resolves against the repo root or either tracked app (`examples/dummy`,
// `dummy/social-media-clone`), because the wiki describes an app's layout and those two ARE apps.
//
// WHAT IS NOT. A placeholder or glob (`<pkg>`, `*`, `{a,b}`, `…`, `$X`) names no one file. A build
// output (`dist/`, `node_modules/`) is absent on a fresh clone. A page under `docs/plans/` or
// `docs/history/`, or `CHANGELOG.md`, is a dated record of a tree that was. And a section opened by
// a `**Historical:**` label — from that line to the next heading — records a tree that was, too.
//
// ZERO-PINNED: no table. A dead path is a one-line edit, and a ratchet at zero is a rule.
//
//   bun run doc-paths  ·  bun run scripts/doc-paths.ts [--json]

// why: a path may name a directory, and `Bun.file().exists()` answers for files only.
import { existsSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { parseScriptArgs } from './lib/args';
import type { MarkdownFile } from './lib/doc-citations';
import { readMarkdown } from './lib/doc-citations';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'doc-paths';
export const MARKER = '**Historical:**';

/** The published surface: `scripts/doc-commands.ts`' set, minus the tracked apps' own pages. */
export const DOC_GLOBS: readonly string[] = [
  '*.md',
  'wiki/**/*.md',
  'docs/**/*.md',
  'packages/*/*.md',
];

/** Where else a path may live: the tracked apps, whose layout the wiki describes. */
export const APP_ROOTS: readonly string[] = ['examples/dummy', 'dummy/social-media-clone'];

/** Dated records and installed or built pages: none of them is a current instruction. */
export const skipDocPage = (path: string): boolean =>
  path.startsWith('docs/plans/') ||
  path.startsWith('docs/history/') ||
  path === 'CHANGELOG.md' ||
  /(?:^|\/)(?:node_modules|dist|\.x)\//.test(path);

export interface DocPathRef {
  readonly line: number;
  readonly path: string;
}

/** `packages/`, `scripts/` or `docs/` at a word start — never inside `subpackages/`. */
const TOKEN = /(?:^|[\s(=:'"[])((?:packages|scripts|docs)\/[^\s`'"(),;\]]*)/g;
const CODE_SPAN = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;
const FENCE = /^\s*(?:```|~~~)/;
const HEADING = /^#{1,6}\s/;
// A fenced line that is ONLY a comment naming a path: `// p`, `/* p */`, `# p`, `-- p`.
const HEADER_COMMENT = /^\s*(?:\/\/|\/\*|#|--)\s*((?:packages|scripts|docs)\/\S+?)\s*(?:\*\/)?\s*$/;
const PLACEHOLDER = /[*?<>{}$…]|\.\.\./;
const BUILD_OUTPUT = /(?:^|\/)(?:dist|node_modules|\.x|coverage)(?:\/|$)|\.tsbuildinfo$/;

/** The path as a file system names it: no `:line[:col]`, `:a-b`, `#anchor` or closing punctuation. */
export function normalizePath(token: string): string | undefined {
  if (PLACEHOLDER.test(token)) return undefined;
  const path = token
    .replace(/#.*$/, '')
    .replace(/(?::\d+(?:-\d+)?)+$/, '')
    .replace(/[.:]+$/, '')
    .replace(/\/+$/, '');
  if (path.split('/').length < 2 || path.endsWith('/')) return undefined;
  if (BUILD_OUTPUT.test(path)) return undefined;
  return path;
}

const tokensIn = (text: string): readonly string[] =>
  [...text.matchAll(TOKEN)].map((match) => match[1] ?? '');

/** Every checkable path on one page, outside a `**Historical:**` section. Pure over the text. */
export function scanDocPaths(file: MarkdownFile): readonly DocPathRef[] {
  const found: DocPathRef[] = [];
  let fenced = false;
  let historical = false;
  file.text.split('\n').forEach((line, index) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return;
    }
    if (!fenced && HEADING.test(line)) historical = false;
    if (!fenced && line.includes(MARKER)) historical = true;
    if (historical) return;
    const raw = fenced
      ? [HEADER_COMMENT.exec(line)?.[1] ?? ''].filter((token) => token !== '')
      : [...line.matchAll(CODE_SPAN)].flatMap((span) => tokensIn(span[2] ?? ''));
    for (const token of raw) {
      const path = normalizePath(token);
      if (path !== undefined) found.push({ line: index + 1, path });
    }
  });
  return found;
}

export type DocPathGapKind = 'dead' | 'unscanned';

export interface DocPathGap {
  readonly kind: DocPathGapKind;
  /** `page:line` for `dead`; the glob list for `unscanned`. */
  readonly at: string;
  /** The path as normalized. Empty for `unscanned`. */
  readonly subject: string;
}

export interface DocPathInput {
  readonly files: readonly MarkdownFile[];
  readonly exists: (path: string) => boolean;
}

/** Pure, so every negative case is a fixture rather than an edit to a page someone else holds. */
export function checkDocPaths(input: DocPathInput): readonly DocPathGap[] {
  if (input.files.length === 0) {
    return [{ kind: 'unscanned', at: DOC_GLOBS.join(', '), subject: '' }];
  }
  const gaps: DocPathGap[] = [];
  const reported = new Set<string>();
  for (const file of input.files) {
    for (const ref of scanDocPaths(file)) {
      if (input.exists(ref.path)) continue;
      const at = `${file.path}:${ref.line}`;
      // One finding per line per path: a table row routinely names the same file twice.
      if (reported.has(`${at} ${ref.path}`)) continue;
      reported.add(`${at} ${ref.path}`);
      gaps.push({ kind: 'dead', at, subject: ref.path });
    }
  }
  return gaps;
}

/** The repo root, then each tracked app: an app-layout path is real if a tracked app has it. */
export const existsIn =
  (root: string) =>
  (path: string): boolean =>
    [root, ...APP_ROOTS.map((app) => join(root, app))].some((base) => existsSync(join(base, path)));

const deadFinding = (gap: DocPathGap): Finding => ({
  code: 'X_DOC_PATH_DEAD',
  cause: `${gap.at} names \`${gap.subject}\`, which exists neither in this repository nor in a tracked app — a reader sent to open it finds nothing`,
  fix: `bun run doc-paths --json   # then edit ${gap.at} to name the file as it is now, or open its section with a ${MARKER} label if the page records a tree that no longer exists`,
  at: gap.at,
});

const unscannedFinding = (gap: DocPathGap): Finding => ({
  code: 'X_CORPUS_UNSCANNED',
  cause: `no published page matched ${gap.at}, so ${SCRIPT} would report green over pages it never read`,
  fix: 'bun run doc-paths --json   # then edit DOC_GLOBS in scripts/doc-paths.ts to the paths this repository publishes its pages under',
  at: 'scripts/doc-paths.ts',
});

export const docPathFindingFor = (gap: DocPathGap): Finding =>
  gap.kind === 'dead' ? deadFinding(gap) : unscannedFinding(gap);

/** Every published page once, sorted, so two runs on one tree report in one order. */
export async function readPublishedPages(root: string): Promise<readonly MarkdownFile[]> {
  const seen = new Map<string, MarkdownFile>();
  for (const glob of DOC_GLOBS) {
    for (const file of await readMarkdown(root, glob, skipDocPage)) seen.set(file.path, file);
  }
  return [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** What this repo contributes to `x verify`'s `manifest` step. */
export const docPathFindings = async (root: string): Promise<readonly Finding[]> =>
  checkDocPaths({ files: await readPublishedPages(root), exists: existsIn(root) }).map(
    docPathFindingFor,
  );

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const files = await readPublishedPages(root);
  const findings = checkDocPaths({ files, exists: existsIn(root) }).map(docPathFindingFor);
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `${files.length} published pages, every backticked repo path resolves`
          : `${findings.length} dead path(s) across ${files.length} published pages`,
      findings,
    },
    args.json,
  );
}
