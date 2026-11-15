// The two edits a template codemod is made of: swap exact snippets of the old template for the new
// ones, or add a file the template added. Mechanical or nothing: a snippet the app rewrote leaves
// the file as it is, reported with the template's own change as a diff to apply by hand.

import type { CodemodApp, CodemodResult } from './codemod';
import { unifiedDiff } from './engine-diff';

export interface SnippetEdit {
  /** The old template's exact text. */
  readonly from: string;
  /** What the new template says in its place. */
  readonly to: string;
  /** Prose (a comment) the app may have reworded: swapped when found, never a reason to skip. */
  readonly optional?: boolean;
}

const NOTHING: CodemodResult = { changed: [], skipped: [] };

/** A file's text as LF without a BOM, and how to put both back: a Windows checkout is supported. */
export interface FileText {
  readonly text: string;
  readonly restore: (text: string) => string;
}

export function fileText(source: string): FileText {
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = source.slice(bom.length);
  const crlf = body.includes('\r\n');
  return {
    text: crlf ? body.replaceAll('\r\n', '\n') : body,
    restore: (text) => `${bom}${crlf ? text.replaceAll('\n', '\r\n') : text}`,
  };
}

/** `path` read as LF text; undefined when the app has no such file. */
export async function readText(app: CodemodApp, path: string): Promise<FileText | undefined> {
  const source = await app.read(path);
  return source === undefined ? undefined : fileText(source);
}

/**
 * Carried across. A removal (`to` inside `from`): `from` is gone. An insert (`from` inside `to`):
 * `to` is there. A swap: `to` is there and `from` is not.
 */
const done = (source: string, edit: SnippetEdit): boolean => {
  if (edit.from.includes(edit.to)) return !source.includes(edit.from);
  if (edit.to.includes(edit.from)) return source.includes(edit.to);
  return source.includes(edit.to) && !source.includes(edit.from);
};

const count = (source: string, part: string): number => source.split(part).length - 1;

/**
 * Every pending `from` swapped for its `to`, or nothing: an edit already carried across is done;
 * one whose `from` is gone too means the app wrote its own, and one whose `from` stands in more than
 * one place is a guess — which the template meant is not in the text — so the file is the author's.
 * Matched on LF text without a BOM, written back with the file's own line ending and BOM.
 */
export async function editSnippets(
  app: CodemodApp,
  path: string,
  edits: readonly SnippetEdit[],
): Promise<CodemodResult> {
  const file = await readText(app, path);
  if (file === undefined) return NOTHING;
  const source = file.text;
  const pending = edits.filter((edit) => !done(source, edit));
  if (pending.every((edit) => edit.optional === true && !source.includes(edit.from))) {
    return NOTHING;
  }
  const wanted = (side: 'from' | 'to'): string =>
    `${edits.map((edit) => edit[side]).join('\n\n')}\n`;
  const skip = (reason: string): CodemodResult => ({
    changed: [],
    skipped: [{ path, reason, diff: unifiedDiff(path, wanted('from'), wanted('to')) }],
  });
  const missing = pending.filter((edit) => edit.optional !== true && !source.includes(edit.from));
  if (missing.length > 0) {
    return skip(
      `the app's copy no longer holds the template text this change replaces (${missing.map((edit) => JSON.stringify(edit.from.split('\n')[0] ?? '')).join(', ')}), so the diff below is the template's change, to make by hand`,
    );
  }
  const twice = pending.find((edit) => count(source, edit.from) > 1);
  if (twice !== undefined) {
    return skip(
      `the template text this change replaces stands in ${String(count(source, twice.from))} places (${JSON.stringify(twice.from.split('\n')[0] ?? '')}), and which one it meant is not decidable: the diff below is the change, to make by hand`,
    );
  }
  let next = source;
  for (const edit of pending) next = next.replace(edit.from, () => edit.to);
  if (next === source) return NOTHING;
  await app.write(path, file.restore(next));
  return { changed: [path], skipped: [] };
}

/** A file the template added since: written when the app has none, never over one it has. */
export async function writeIfAbsent(
  app: CodemodApp,
  path: string,
  source: string,
): Promise<CodemodResult> {
  if (await app.exists(path)) return NOTHING;
  await app.write(path, source);
  return { changed: [path], skipped: [] };
}

/** Several results as one, in order. */
export const mergeResults = (results: readonly CodemodResult[]): CodemodResult => ({
  changed: results.flatMap((result) => result.changed),
  skipped: results.flatMap((result) => result.skipped),
});
