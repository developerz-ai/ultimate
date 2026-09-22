#!/usr/bin/env bun
// Add an error code in ONE edit: its registration in the owning package's `errors.ts` and its row
// in `wiki/Error-Codes.md`, written together or not at all. Codes kept landing in a package a wave
// before their row, and the `errors` step went red at the end of the wave (DX ledger #11) — three
// realtime codes in one round. Both edits are planned before either is written, so a refusal
// leaves both files as they were.
//
//   bun run scripts/new-error-code.ts X_FOO_BAR --package realtime --title 'one line' \
//     --fix 'x … or an edit naming a file' [--meaning 'the typical cause'] [--section '<## heading>'] [--json]
//
// The throw site is still the author's: this registers the code and documents it, and the class or
// factory that raises it is the edit only the author can make.

import { flagString, parseScriptArgs } from './lib/args';
import type { NewErrorCode } from './lib/error-code-plan';
import { registerIn, rowIn, validateNewCode } from './lib/error-code-plan';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { ScriptError } from './lib/script-error';

const SCRIPT = 'new-error-code';
export const WIKI_PAGE = 'wiki/Error-Codes.md';

export interface Planned {
  readonly errorsPath: string;
  readonly errorsTs: string;
  readonly wiki: string;
}

/** Both edits, planned against the files as they are — nothing is written here. */
export async function planFiles(root: string, input: NewErrorCode): Promise<Planned> {
  validateNewCode(input);
  const errorsPath = `packages/${input.pkg}/src/errors.ts`;
  const errorsFile = Bun.file(`${root}/${errorsPath}`);
  if (!(await errorsFile.exists())) {
    throw new ScriptError({
      code: 'X_NEW_ERROR_CODE_INVALID',
      cause: `${errorsPath} does not exist, so @ultimat3/${input.pkg} is not a package that registers codes there`,
      fix: 'bun run workspaces:list — then rerun with --package set to one of the listed package directories',
    });
  }
  const errorsTs = registerIn(await errorsFile.text(), errorsPath, input);
  const wiki = rowIn(await Bun.file(`${root}/${WIKI_PAGE}`).text(), input);
  return { errorsPath, errorsTs, wiki };
}

export function inputFrom(argv: readonly string[]): NewErrorCode {
  const args = parseScriptArgs(argv);
  const [code] = args.positionals;
  const pkg = flagString(args, 'package');
  const title = flagString(args, 'title');
  const fix = flagString(args, 'fix');
  if (code === undefined || pkg === undefined || title === undefined || fix === undefined) {
    throw new ScriptError({
      code: 'X_NEW_ERROR_CODE_INVALID',
      cause:
        'a code, --package, --title and --fix are all required — the registration needs the title and the wiki row needs the fix',
      fix: "bun run scripts/new-error-code.ts X_PKG_WHAT_FAILED --package <pkg> --title '<one line>' --fix '<command or edit>'",
    });
  }
  return {
    code,
    pkg,
    title,
    fix,
    meaning: flagString(args, 'meaning'),
    section: flagString(args, 'section'),
  };
}

export async function newErrorCode(root: string, argv: readonly string[]) {
  const input = inputFrom(argv);
  const planned = await planFiles(root, input);
  await Bun.write(`${root}/${planned.errorsPath}`, planned.errorsTs);
  await Bun.write(`${root}/${WIKI_PAGE}`, planned.wiki);
  return { input, written: [planned.errorsPath, WIKI_PAGE] };
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const json = parseScriptArgs(argv).json;
  try {
    const { input, written } = await newErrorCode(repoRoot(), argv);
    report(
      {
        ok: true,
        script: SCRIPT,
        summary: `${input.code} registered in ${written[0]} and documented in ${WIKI_PAGE} — the throw site is yours`,
        data: { code: input.code, written },
      },
      json,
    );
  } catch (error) {
    if (!(error instanceof ScriptError)) throw error;
    report(
      { ok: false, script: SCRIPT, summary: 'nothing was written', findings: [error.toFinding()] },
      json,
    );
  }
}
