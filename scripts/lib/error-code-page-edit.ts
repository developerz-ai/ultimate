// The page half of a new error code: its row at its sorted place on `wiki/Error-Codes-<owner>.md`
// (the page created on an owner's first code) and the index regenerated to match, planned from
// the snapshot so `writePlanned` lands both or neither. Shared by the package and the script mode.

import { renderFixShellArg } from '../../packages/core/src/error-render';
import { renderIndex, withIndex } from './error-code-index';
import type { ErrorCodePage } from './error-code-pages';
import {
  ERROR_CODE_INDEX,
  errorCodePageFiles,
  hasCodeTable,
  insertCodeRow,
  ownerPage,
  ownerPageText,
} from './error-code-pages';
import type { NewErrorCode } from './error-code-plan';
import { codeRowFor } from './error-code-plan';
import type { FileEdit } from './planned-writes';
import { ScriptError } from './script-error';

export interface PageEditInput {
  readonly root: string;
  /** The snapshot reader: every page is read through it, so a page that moves is a refusal. */
  readonly read: (path: string) => Promise<string | undefined>;
  readonly input: NewErrorCode;
  /** `input.pkg`, or `scripts` for a code a repo script owns. */
  readonly owner: string;
  /** An edit the index takes before it is regenerated: the never-ships entry, for a script code. */
  readonly editIndex?: (index: string) => string;
}

/** The owner page with the row, then the index regenerated over every page as it will be. */
export async function planPageEdits(edit: PageEditInput): Promise<readonly FileEdit[]> {
  const { input, owner, read } = edit;
  const target = ownerPage(owner);
  const files = await errorCodePageFiles(edit.root);
  const paths = files.includes(target) ? files : [...files, target];
  const pages: ErrorCodePage[] = [];
  for (const path of paths) {
    const text = await read(path);
    if (text !== undefined) pages.push({ path, text });
  }
  // The index's generated block is not a page documenting anything: it restates the owner pages,
  // and its own preamble names the code that guards it.
  const said = (page: ErrorCodePage): string =>
    page.path === ERROR_CODE_INDEX ? (withIndex(page.text, []) ?? page.text) : page.text;
  const holder = pages.find((page) => said(page).includes(`\`${input.code}\``));
  if (holder !== undefined) {
    throw new ScriptError({
      code: 'X_NEW_ERROR_CODE_EXISTS',
      cause: `${holder.path} already documents ${input.code}`,
      fix: `x errors explain ${renderFixShellArg(input.code, '<CODE>')} --json — then pick a new code, or edit its existing row in ${holder.path}`,
    });
  }
  const current = pages.find((page) => page.path === target)?.text ?? ownerPageText(owner);
  if (!hasCodeTable(current)) {
    throw new ScriptError({
      code: 'X_NEW_ERROR_CODE_INVALID',
      cause: `${target} carries no | Code | table to add ${input.code}'s row to`,
      fix: `edit ${target} to open its table with the line "| Code | Means | Typical cause | Fix |" and a "|---|---|---|---|" under it, then rerun the same bun run new-error-code command`,
    });
  }
  const page = insertCodeRow(current, codeRowFor(input));
  const after = [...pages.filter((one) => one.path !== target), { path: target, text: page }];
  const index = (edit.editIndex ?? ((text) => text))(
    pages.find((one) => one.path === ERROR_CODE_INDEX)?.text ?? '',
  );
  const regenerated = withIndex(index, renderIndex(after));
  if (regenerated === undefined) {
    throw new ScriptError({
      code: 'X_NEW_ERROR_CODE_INVALID',
      cause: `${ERROR_CODE_INDEX} has no generated index block, so the code would land on ${target} and in no index`,
      fix: 'bun run scripts/error-code-pages.ts --json   # it names the two marker lines to restore; then rerun the same bun run new-error-code command',
    });
  }
  return [
    { path: target, text: page },
    { path: ERROR_CODE_INDEX, text: regenerated },
  ];
}
