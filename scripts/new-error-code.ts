#!/usr/bin/env bun
// Add an error code in ONE edit: its registration in the owning package's `errors.ts`, its row in
// `wiki/Error-Codes.md` and — for a package that types one fix per code (`FIX_TABLES`: the CLI's
// `CLI_FIXES`) — that row too, written together or not at all. Codes kept landing in a package a wave
// before their row, and the `errors` step went red at the end of the wave (DX ledger #11) — three
// realtime codes in one round. Both edits are planned before either is written, so a refusal
// leaves both files as they were.
//
//   bun run scripts/new-error-code.ts X_FOO_BAR --package realtime --title 'one line' \
//     --cause 'what usually makes it happen' --fix 'x … or an edit naming a file' \
//     [--status <n> | --off-socket] [--section '<## heading>'] [--json]
//
// `--status`/`--off-socket`: exactly one for a tier <= 4 package, neither above it (below).
//
// THE STATUS IS PART OF THE EDIT. A code owned by a tier <= 4 package needs a row in
// `packages/http/src/error-map.ts` or a pin in `scripts/error-map-backlog.ts`, or the gate's
// `errors` step is red with `X_ERROR_STATUS_MISSING` one command later. Exactly one of
// `--status <n>` (it can answer a request: write the row) and `--off-socket` (it never does: write
// the pin) is required there, because only the author knows which.
//
// The throw site is still the author's: this registers the code and documents it, and the class or
// factory that raises it is the edit only the author can make.

import { flagBool, flagString, parseScriptArgs } from './lib/args';
import type { NewErrorCode } from './lib/error-code-plan';
import {
  backlogPinIn,
  FIX_TABLES,
  fixRowIn,
  registerIn,
  rowIn,
  statusRowIn,
  validateNewCode,
} from './lib/error-code-plan';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { ScriptError } from './lib/script-error';
import { tierOf } from './lib/tiers';

const SCRIPT = 'new-error-code';
export const WIKI_PAGE = 'wiki/Error-Codes.md';
/** The composed table — what the gate's `errors` step reads. Rows are written to its SLICES. */
export const STATUS_TABLE = 'packages/http/src/error-map.ts';
export const STATUS_BACKLOG = 'scripts/error-map-backlog.ts';
/**
 * `scripts/error-map.ts`'s `HTTP_STATUS_MAX_TIER`, restated: importing that module loads
 * `@ultimat3/http`'s barrel, and a generator has to run while a package is mid-edit. The test
 * holds the two equal.
 */
export const STATUS_TABLE_MAX_TIER = 4;

/**
 * The slice of the status table a package's rows live in: `@ultimat3/http`'s own file, else one per
 * tier. The table was ONE file until it reached the line ceiling at exactly the next code; a slice
 * per tier is what keeps "add a row" from being "split a file" again.
 */
export function statusTableFor(pkg: string): string {
  return pkg === 'http'
    ? 'packages/http/src/error-map-http.ts'
    : `packages/http/src/error-map-tier-${tierOf(pkg)}.ts`;
}

/** Every slice a row can be in — a code is refused if ANY of them already names it. */
export const STATUS_TABLE_SLICES: readonly string[] = Object.freeze([
  'packages/http/src/error-map-http.ts',
  ...[0, 1, 2, 3, 4].map((tier) => `packages/http/src/error-map-tier-${tier}.ts`),
]);

/** Where the code's HTTP status was decided: a row, a pin, or — above the table's tiers — nowhere. */
export type StatusDecision =
  | { readonly kind: 'row'; readonly status: number }
  | { readonly kind: 'pin' }
  | { readonly kind: 'none' };

const RERUN_STATUS =
  "bun run scripts/new-error-code.ts <CODE> --package <pkg> --title '…' --cause '…' --fix '…' --status <n>   # it can answer a request; or --off-socket instead: it never does";

/** Exactly one of the two for a tier <= 4 package, neither above it. Refused before any read. */
export function statusDecision(pkg: string, argv: readonly string[]): StatusDecision {
  const args = parseScriptArgs(argv);
  const status = flagString(args, 'status');
  const offSocket = flagBool(args, 'off-socket');
  if (tierOf(pkg) > STATUS_TABLE_MAX_TIER) {
    if (status === undefined && !offSocket) return { kind: 'none' };
    throw new ScriptError({
      code: 'X_NEW_ERROR_CODE_INVALID',
      cause: `@ultimat3/${pkg} is tier ${tierOf(pkg)}, and ${STATUS_TABLE} covers tiers <= ${STATUS_TABLE_MAX_TIER} — its codes take neither --status nor --off-socket`,
      fix: "rerun without --status and --off-socket: bun run scripts/new-error-code.ts <CODE> --package <pkg> --title '…' --cause '…' --fix '…'",
    });
  }
  if ((status === undefined) === !offSocket) {
    throw new ScriptError({
      code: 'X_NEW_ERROR_CODE_INVALID',
      cause: `@ultimat3/${pkg} is tier ${tierOf(pkg)}, so its codes need an HTTP status decided: exactly one of --status <n> and --off-socket, and this run gave ${status === undefined ? 'neither' : 'both'}`,
      fix: RERUN_STATUS,
    });
  }
  if (status === undefined) return { kind: 'pin' };
  const parsed = Number(status);
  if (!Number.isInteger(parsed) || parsed < 400 || parsed > 599) {
    throw new ScriptError({
      code: 'X_NEW_ERROR_CODE_INVALID',
      cause: '--status is not a whole HTTP error status between 400 and 599',
      fix: RERUN_STATUS,
    });
  }
  return { kind: 'row', status: parsed };
}

export interface Planned {
  readonly errorsPath: string;
  readonly errorsTs: string;
  readonly wiki: string;
  /** The third edit, when the code's tier has a status to decide: the table or the backlog. */
  readonly status?: { readonly path: string; readonly text: string } | undefined;
  /** The package's typed fix table, when it keeps one (`FIX_TABLES`): the `--fix` line as a row. */
  readonly fixes?: { readonly path: string; readonly text: string } | undefined;
}

/** Every edit, planned against the files as they are — nothing is written here. */
export async function planFiles(
  root: string,
  input: NewErrorCode,
  decision: StatusDecision = { kind: 'none' },
): Promise<Planned> {
  validateNewCode(input);
  // In order: `error-codes.ts` where a package split its titles out of `errors.ts` (`@ultimat3/cli`
  // did at the 500-line ceiling), `<pkg>-error-codes.ts` where `error-codes.ts` is the REGISTRY
  // itself (`@ultimat3/core`), then `errors.ts`, then `<pkg>-error.ts` where the registry was split
  // out so a browser module can raise a code (`@ultimat3/entity`). The first file in a shape the planner can add to
  // wins; a file it cannot is passed over, and any other refusal — the code already named — stops
  // the search, so a code is never added to a later file because an earlier one already had it.
  const candidates = [
    `packages/${input.pkg}/src/error-codes.ts`,
    `packages/${input.pkg}/src/${input.pkg}-error-codes.ts`,
    `packages/${input.pkg}/src/errors.ts`,
    `packages/${input.pkg}/src/${input.pkg}-error.ts`,
  ];
  let registered: { readonly errorsPath: string; readonly errorsTs: string } | undefined;
  let unrecognised: ScriptError | undefined;
  for (const errorsPath of candidates) {
    const file = Bun.file(`${root}/${errorsPath}`);
    if (!(await file.exists())) continue;
    try {
      registered = { errorsPath, errorsTs: registerIn(await file.text(), errorsPath, input) };
      break;
    } catch (error) {
      if (!(error instanceof ScriptError) || error.code !== 'X_NEW_ERROR_CODE_PATTERN_UNKNOWN') {
        throw error;
      }
      unrecognised ??= error;
    }
  }
  if (registered === undefined) {
    if (unrecognised !== undefined) throw unrecognised;
    throw new ScriptError({
      code: 'X_NEW_ERROR_CODE_INVALID',
      cause: `none of ${candidates.join(', ')} exists, so @ultimat3/${input.pkg} is not a package that registers codes there`,
      fix: 'bun run workspaces:list — then rerun with --package set to one of the listed package directories',
    });
  }
  const { errorsPath, errorsTs } = registered;
  const wiki = rowIn(await Bun.file(`${root}/${WIKI_PAGE}`).text(), input);
  const fixesPath = FIX_TABLES.get(input.pkg);
  let fixes: Planned['fixes'];
  if (fixesPath !== undefined) {
    // A table that is gone reads as one with no literal: the same coded refusal, never an ENOENT.
    const table = Bun.file(`${root}/${fixesPath}`);
    const current = (await table.exists()) ? await table.text() : '';
    fixes = { path: fixesPath, text: fixRowIn(current, fixesPath, input) };
  }
  if (decision.kind === 'none') return { errorsPath, errorsTs, wiki, fixes };
  const path = decision.kind === 'row' ? statusTableFor(input.pkg) : STATUS_BACKLOG;
  const current = await Bun.file(`${root}/${path}`).text();
  if (decision.kind === 'pin') {
    return {
      errorsPath,
      errorsTs,
      wiki,
      fixes,
      status: { path, text: backlogPinIn(current, path, input) },
    };
  }
  // The table is composed by spread, which takes the last duplicate silently: a code another
  // slice already names is refused here, by the same check that guards the slice being written.
  for (const other of STATUS_TABLE_SLICES) {
    const file = Bun.file(`${root}/${other}`);
    if (other !== path && (await file.exists()))
      statusRowIn(await file.text(), other, input, decision.status);
  }
  const text = statusRowIn(current, path, input, decision.status);
  return { errorsPath, errorsTs, wiki, fixes, status: { path, text } };
}

export function inputFrom(argv: readonly string[]): NewErrorCode {
  const args = parseScriptArgs(argv);
  const [code] = args.positionals;
  const pkg = flagString(args, 'package');
  const title = flagString(args, 'title');
  const fix = flagString(args, 'fix');
  const cause = flagString(args, 'cause');
  if (
    code === undefined ||
    pkg === undefined ||
    title === undefined ||
    cause === undefined ||
    fix === undefined
  ) {
    throw new ScriptError({
      code: 'X_NEW_ERROR_CODE_INVALID',
      cause:
        'a code, --package, --title, --cause and --fix are all required — the registration needs the title and the wiki row needs the cause and the fix',
      fix: "bun run scripts/new-error-code.ts X_PKG_WHAT_FAILED --package <pkg> --title '<one line>' --cause '<what usually makes it happen>' --fix '<command or edit>'",
    });
  }
  return {
    code,
    pkg,
    title,
    cause,
    fix,
    section: flagString(args, 'section'),
  };
}

export async function newErrorCode(root: string, argv: readonly string[]) {
  const input = inputFrom(argv);
  const planned = await planFiles(root, input, statusDecision(input.pkg, argv));
  await Bun.write(`${root}/${planned.errorsPath}`, planned.errorsTs);
  await Bun.write(`${root}/${WIKI_PAGE}`, planned.wiki);
  for (const extra of [planned.fixes, planned.status]) {
    if (extra !== undefined) await Bun.write(`${root}/${extra.path}`, extra.text);
  }
  return {
    input,
    written: [
      planned.errorsPath,
      WIKI_PAGE,
      ...(planned.fixes === undefined ? [] : [planned.fixes.path]),
      ...(planned.status === undefined ? [] : [planned.status.path]),
    ],
    fixesPath: planned.fixes?.path,
    statusPath: planned.status?.path,
  };
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const json = parseScriptArgs(argv).json;
  try {
    const { input, written, fixesPath, statusPath } = await newErrorCode(repoRoot(), argv);
    const also = [
      fixesPath === undefined ? '' : `, its fix added to ${fixesPath}`,
      statusPath === undefined ? '' : `, its HTTP status decided in ${statusPath}`,
    ].join('');
    report(
      {
        ok: true,
        script: SCRIPT,
        summary: `${input.code} registered in ${written[0]} and documented in ${WIKI_PAGE}${also} — the throw site is yours`,
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
