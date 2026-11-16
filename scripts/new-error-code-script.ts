// `new-error-code --script <file>`: a code a repo script owns. `scripts/` never ships, so there is
// no package to register it in and no HTTP status to decide — only wiki/Error-Codes.md's
// never-ships list and its table row, which `gate-codes.ts` holds complete. Both were hand edits
// (X_UPGRADE_FIXTURE_*, X_GUARD_FORMS_ARCHIVE_FAILED), and one of the two was forgotten each time.

import type { NewErrorCode } from './lib/error-code-plan';
import { rowIn, validateNewCode } from './lib/error-code-plan';
import type { FileEdit, Snapshot } from './lib/planned-writes';
import { snapshotReader } from './lib/planned-writes';
import { ScriptError } from './lib/script-error';

/** The page section every script code's row lives in today. */
export const SCRIPT_SECTION = 'CLI and verify';

/**
 * `gate-codes.ts`' lead, restated: that module loads the `@ultimat3/core` barrel through the CLI's
 * error contract, and a generator has to run while a package is mid-edit. The test holds the two equal.
 */
export const NEVER_SHIPS_LEAD = "this repository's own gate scripts (";

const RERUN =
  "bun run scripts/new-error-code.ts X_SCRIPT_WHAT_FAILED --script scripts/<file>.ts --title '<one line>' --cause '<what usually makes it happen>' --fix '<command or edit>'";

const invalid = (cause: string, fix: string = RERUN): ScriptError =>
  new ScriptError({ code: 'X_NEW_ERROR_CODE_INVALID', cause, fix });

/** Flags that belong to a package code: refused beside `--script`, never quietly ignored. */
export const PACKAGE_ONLY_FLAGS = ['package', 'status', 'off-socket', 'browser', 'server-only'];

/** Whether the list already stands for `code`: named outright, or by a `X_FAMILY_*` wildcard. */
const listed = (span: string, code: string): boolean =>
  [...span.matchAll(/`(X_[A-Z0-9_]*\*?)`/g)].some((match) => {
    const entry = match[1] ?? '';
    return entry === code || (entry.endsWith('*') && code.startsWith(entry.slice(0, -1)));
  });

/** The page with `code` appended to the never-ships parenthesis; unchanged when it already covers it. */
export function neverShipsIn(wiki: string, code: string): string {
  const start = wiki.indexOf(NEVER_SHIPS_LEAD);
  const close = start === -1 ? -1 : wiki.indexOf(')', start + NEVER_SHIPS_LEAD.length);
  if (close === -1) {
    throw invalid(
      `wiki/Error-Codes.md has no "${NEVER_SHIPS_LEAD}…)" list to add ${code} to, so it is not the page gate-codes reads`,
      'bun run scripts/gate-codes.ts --json   # after restoring the never-ships sentence on wiki/Error-Codes.md',
    );
  }
  if (listed(wiki.slice(start, close), code)) return wiki;
  return `${wiki.slice(0, close)}, \`${code}\`${wiki.slice(close)}`;
}

/** The script that owns the code: repo-relative, under `scripts/`, and in the tree. */
async function ownerScript(root: string, script: string): Promise<string> {
  const path = script.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!/^scripts\/[\w./-]+\.ts$/.test(path) || path.includes('..')) {
    throw invalid(
      `--script ${path} is not a .ts file under scripts/, and only a repo script owns a code that never ships`,
    );
  }
  if (!(await Bun.file(`${root}/${path}`).exists())) {
    throw invalid(
      `--script ${path} does not exist in this tree, so no script owns the code yet`,
      `ls scripts/   # then rerun: ${RERUN}`,
    );
  }
  return path;
}

/** The one edit a script code is: wiki/Error-Codes.md, its list entry and its row, planned together. */
export async function planScriptCode(
  root: string,
  input: NewErrorCode,
  script: string,
  wikiPath: string,
  snapshot: Snapshot,
): Promise<FileEdit> {
  validateNewCode(input);
  await ownerScript(root, script);
  const wiki = (await snapshotReader(root, snapshot)(wikiPath)) ?? '';
  const row = rowIn(wiki, { ...input, section: input.section ?? SCRIPT_SECTION });
  return { path: wikiPath, text: neverShipsIn(row, input.code) };
}
