// Whether a template's change between two refs is confined to its leading comment block — the
// generator's own header, outside the template string an app receives. The two template rules
// (guard refresh, codemods) skip such a change, so a header sweep asks no upgrade row of anyone.

import type { GitRunner } from './git-fetch';

/**
 * The file with its leading comment block dropped. That block is the generator's own header: a
 * guard's text lives in the template string below it, so an edit confined to it ships nothing.
 */
const bodyOf = (text: string): string => {
  const lines = text.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '' && !line.trim().startsWith('//'));
  // trimEnd: `run` trims what git printed, so a shown file has lost the final newline a read keeps.
  return first === -1 ? '' : lines.slice(first).join('\n').trimEnd();
};

/** `path` at `ref`, or in the working tree when `ref` is absent; `undefined` when unreadable. */
async function textAt(
  root: string,
  ref: string | undefined,
  path: string,
  runner: GitRunner,
): Promise<string | undefined> {
  if (ref === undefined) {
    const file = Bun.file(`${root}/${path}`);
    return (await file.exists()) ? await file.text() : undefined;
  }
  const shown = await runner(['git', 'show', `${ref}:${path}`], { cwd: root });
  return shown.ok ? shown.output : undefined;
}

/**
 * Whether the range changed `path` only in its leading comment block (a header sweep). A side
 * that cannot be read — the file added, removed, or a git that will not answer — is a change.
 */
export async function headerOnly(
  root: string,
  refs: readonly string[],
  path: string,
  runner: GitRunner,
): Promise<boolean> {
  const before = await textAt(root, refs[0], path, runner);
  const after = await textAt(root, refs[1], path, runner);
  return before !== undefined && after !== undefined && bodyOf(before) === bodyOf(after);
}
