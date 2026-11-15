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

/**
 * Carried across: `to` is there, and `from` is not — unless `from` is part of `to` (an insert
 * beside a line that stays). A removal's `to` sits inside its own `from`, so `to` alone is no proof.
 */
const done = (source: string, edit: SnippetEdit): boolean =>
  source.includes(edit.to) && (edit.to.includes(edit.from) || !source.includes(edit.from));

/**
 * Every pending `from` swapped for its `to`, or nothing: an edit whose `to` is already there is
 * done; one whose `from` is gone too means the app wrote its own, and the file is not this
 * codemod's to finish.
 */
export async function editSnippets(
  app: CodemodApp,
  path: string,
  edits: readonly SnippetEdit[],
): Promise<CodemodResult> {
  const source = await app.read(path);
  if (source === undefined) return NOTHING;
  const pending = edits.filter((edit) => !done(source, edit));
  if (pending.every((edit) => edit.optional === true && !source.includes(edit.from))) {
    return NOTHING;
  }
  const missing = pending.filter((edit) => edit.optional !== true && !source.includes(edit.from));
  if (missing.length > 0) {
    const wanted = (side: 'from' | 'to'): string =>
      `${edits.map((edit) => edit[side]).join('\n\n')}\n`;
    return {
      changed: [],
      skipped: [
        {
          path,
          reason: `the app's copy no longer holds the template text this change replaces (${missing.map((edit) => JSON.stringify(edit.from.split('\n')[0] ?? '')).join(', ')}), so the diff below is the template's change, to make by hand`,
          diff: unifiedDiff(path, wanted('from'), wanted('to')),
        },
      ],
    };
  }
  let next = source;
  for (const edit of pending) next = next.replace(edit.from, () => edit.to);
  if (next === source) return NOTHING;
  await app.write(path, next);
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
