// Where a markdown page hands a reader a command. One scanner, shared by the two doc-command
// rules — `scripts/doc-fixes.ts` (the `fix` column of the error reference) and
// `scripts/doc-commands.ts` (every other page) — because two scanners over two file sets is the
// drift both rules exist to refuse.

import type { FixCitation } from '@ultimat3/cli';
import { fixCitations } from '@ultimat3/cli';

export interface MarkdownFile {
  readonly path: string;
  readonly text: string;
}

/** One `x …` a page wrote, with the span it was written in so a finding can quote it back. */
export interface DocCitation {
  readonly path: string;
  /** 1-based, so `path:line` opens it in an editor. */
  readonly line: number;
  /** The code span or fenced line, trimmed — what the reader would copy. */
  readonly span: string;
  readonly citation: FixCitation;
}

/**
 * Fence languages whose contents are shell, not a program. A `ts` fence's `x` is a variable and
 * every `x` in one would be a false citation; a bare fence and a `sh` fence are what a reader
 * pastes into a terminal, and `wiki/Installation.md`'s rendered `X_ENV_MISSING` block — the one
 * printing `fix:   x env check --fix` — is a bare one.
 */
const SHELL_FENCE: ReadonlySet<string> = new Set(['', 'sh', 'bash', 'shell', 'console', 'text']);

const FENCE = /^\s*(?:```|~~~)\s*([A-Za-z0-9+#-]*)/;

/**
 * Inline code spans, per GFM: a run of N backticks closed by a run of exactly N. Prose OUTSIDE a
 * span is deliberately not read — "the x axis of the chart" is not a citation, and a rule that
 * read bare prose would report findings on sentences nobody can run.
 */
const CODE_SPAN = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;

/** Every runnable-looking span on one line: the fenced line itself, or each code span in it. */
function spansOf(line: string, fence: string | undefined): readonly string[] {
  if (fence !== undefined) return SHELL_FENCE.has(fence) ? [line] : [];
  return [...line.matchAll(CODE_SPAN)].map((match) => match[2] ?? '');
}

/**
 * Every `x <command> …` a page presents as runnable. Pure over the file's text, so the negative
 * case is a fixture rather than an edit to a page three other people are rewriting.
 */
export function scanDocCitations(file: MarkdownFile): readonly DocCitation[] {
  const found: DocCitation[] = [];
  const lines = file.text.split('\n');
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const opener = FENCE.exec(line);
    if (opener !== null) {
      fence = fence === undefined ? (opener[1] ?? '').toLowerCase() : undefined;
      continue;
    }
    for (const span of spansOf(line, fence)) {
      for (const citation of fixCitations(span)) {
        found.push({ path: file.path, line: index + 1, span: span.trim(), citation });
      }
    }
  }
  return found;
}

/** Every markdown file under a glob, sorted, so two runs on one tree report in one order. */
export async function readMarkdown(
  root: string,
  glob: string,
  skip: (path: string) => boolean = () => false,
): Promise<readonly MarkdownFile[]> {
  const files: MarkdownFile[] = [];
  for await (const path of new Bun.Glob(glob).scan({ cwd: root, absolute: false })) {
    if (skip(path)) continue;
    files.push({ path, text: await Bun.file(`${root}/${path}`).text() });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}
