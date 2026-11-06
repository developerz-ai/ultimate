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
//     [--status <n> | --off-socket] [--section '<## heading>'] [--dry-run] [--json]
//
// `--status`/`--off-socket`: exactly one for a tier <= 4 package, neither above it (below).
//
// THE STATUS IS PART OF THE EDIT. A code owned by a tier <= 4 package needs a row in
// `packages/http/src/error-map.ts` or a pin in `scripts/error-map-backlog.ts`, or the gate's
// `errors` step is red with `X_ERROR_STATUS_MISSING` one command later. Exactly one of
// `--status <n>` (it can answer a request: write the row) and `--off-socket` (it never does: write
// the pin into `OFF_SOCKET`, the decided list — never `UNDECIDED`, which only shrinks) is required
// there, because only the author knows which.
//
// The throw site is still the author's: this registers the code and documents it, and the class or
// factory that raises it is the edit only the author can make.

import type { KnownFlags } from './lib/args';
import { flagBool, flagString, parseScriptArgs } from './lib/args';
import type { NewErrorCode } from './lib/error-code-plan';
import {
  backlogPinIn,
  codeNameIn,
  FIX_TABLES,
  fixRowIn,
  registerIn,
  rowIn,
  statusRowIn,
  validateNewCode,
} from './lib/error-code-plan';
import { report } from './lib/log';
import type { Snapshot } from './lib/planned-writes';
import { snapshotReader, writePlanned } from './lib/planned-writes';
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
  // `@ultimat3/http` holds every code it owns to a status row (`error-map.test.ts`: "every code
  // this package can throw has a row"), so an off-socket pin there writes a code that test refuses.
  if (status === undefined && pkg === 'http') {
    throw new ScriptError({
      code: 'X_NEW_ERROR_CODE_INVALID',
      cause:
        '@ultimat3/http gives every code it owns a status row, so --off-socket would write a code its own error-map test refuses',
      fix: "bun run scripts/new-error-code.ts <CODE> --package http --title '…' --cause '…' --fix '…' --status 500   # a code that never reaches a caller takes 500",
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

/** The literal `--off-socket` writes into: the DECIDED list, never the shrink-only `UNDECIDED`. */
export const OFF_SOCKET_LITERAL = 'export const OFF_SOCKET';

/**
 * The pin, confined to `OFF_SOCKET`'s literal. `backlogPinIn` places a code in the first group of
 * its package it meets, and the file holds TWO lists that share package names — given the whole
 * file, a decided code would land in the undecided list the ratchet refuses to grow. A code either
 * list already pins is refused against the whole file first.
 */
export function offSocketPinIn(backlog: string, path: string, input: NewErrorCode): string {
  if (backlog.includes(`'${input.code}'`)) return backlogPinIn(backlog, path, input);
  const start = backlog.indexOf(OFF_SOCKET_LITERAL);
  const close = start < 0 ? -1 : backlog.indexOf('\n};', start);
  if (close < 0) {
    throw new ScriptError({
      code: 'X_NEW_ERROR_CODE_INVALID',
      cause: `${path} has no \`${OFF_SOCKET_LITERAL}\` literal to pin ${input.code} in, so it is not the two-list backlog this generator writes`,
      fix: `bun run scripts/error-map.ts --json   # after pinning ${input.code} under ${input.pkg} in OFF_SOCKET in ${path} by hand`,
    });
  }
  const end = close + '\n};'.length;
  const pinned = backlogPinIn(backlog.slice(start, end), path, input);
  return `${backlog.slice(0, start)}${pinned}${backlog.slice(end)}`;
}

export interface Planned {
  readonly errorsPath: string;
  readonly errorsTs: string;
  readonly wiki: string;
  /**
   * The package's code NAME table (`SEO_ERROR_CODES`), when it keeps one apart from the titles:
   * written in `errorsPath` itself when it lives there, else in the package's `errors.ts` (`ui`).
   */
  readonly names?: { readonly path: string; readonly text: string } | undefined;
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
  /** Filled with the text of every file the plan read: what `writePlanned` checks against. */
  snapshot: Snapshot = new Map(),
): Promise<Planned> {
  validateNewCode(input);
  const read = snapshotReader(root, snapshot);
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
    // Where a package split its TITLES out of `errors.ts` so the constructors can be side-effect
    // free (`@ultimat3/action`, `http` and `realtime` — `error-titles.ts`; `ui` — `error-registry.ts`).
    // After `errors.ts` on purpose: a file the planner cannot add to is passed over, so these only
    // win where `errors.ts` is only the constructors.
    `packages/${input.pkg}/src/error-titles.ts`,
    `packages/${input.pkg}/src/error-registry.ts`,
  ];
  let registered: { readonly errorsPath: string; readonly errorsTs: string } | undefined;
  let unrecognised: ScriptError | undefined;
  for (const errorsPath of candidates) {
    const text = await read(errorsPath);
    if (text === undefined) continue;
    try {
      registered = { errorsPath, errorsTs: registerIn(text, errorsPath, input) };
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
  const { errorsPath } = registered;
  let errorsTs = registered.errorsTs;
  let names: Planned['names'];
  const inFile = codeNameIn(errorsTs, errorsPath, input, false);
  if (inFile !== undefined) errorsTs = inFile;
  else {
    // `@ultimat3/ui` keeps the registration in `error-registry.ts` and the name table in `errors.ts`.
    const companion = `packages/${input.pkg}/src/errors.ts`;
    const held = companion === errorsPath ? undefined : await read(companion);
    if (held !== undefined) {
      const text = codeNameIn(held, companion, input, true);
      if (text !== undefined) names = { path: companion, text };
    }
  }
  const wiki = rowIn((await read(WIKI_PAGE)) ?? '', input);
  const fixesPath = FIX_TABLES.get(input.pkg);
  let fixes: Planned['fixes'];
  if (fixesPath !== undefined) {
    // A table that is gone reads as one with no literal: the same coded refusal, never an ENOENT.
    const current = (await read(fixesPath)) ?? '';
    fixes = { path: fixesPath, text: fixRowIn(current, fixesPath, input) };
  }
  if (decision.kind === 'none') return { errorsPath, errorsTs, wiki, names, fixes };
  const path = decision.kind === 'row' ? statusTableFor(input.pkg) : STATUS_BACKLOG;
  const current = (await read(path)) ?? '';
  if (decision.kind === 'pin') {
    return {
      errorsPath,
      errorsTs,
      wiki,
      names,
      fixes,
      status: { path, text: offSocketPinIn(current, path, input) },
    };
  }
  // The table is composed by spread, which takes the last duplicate silently: a code another
  // slice already names is refused here, by the same check that guards the slice being written.
  for (const other of STATUS_TABLE_SLICES) {
    const slice = other === path ? undefined : await read(other);
    if (slice !== undefined) statusRowIn(slice, other, input, decision.status);
  }
  const text = statusRowIn(current, path, input, decision.status);
  return { errorsPath, errorsTs, wiki, names, fixes, status: { path, text } };
}

/** Every flag this script reads. Anything else is refused: a misspelt `--dry-run` used to write. */
const KNOWN: KnownFlags = {
  names: ['package', 'title', 'cause', 'fix', 'status', 'off-socket', 'section', 'dry-run'],
  refuse: (unknown) =>
    new ScriptError({
      code: 'X_NEW_ERROR_CODE_INVALID',
      cause: `unknown flag(s): ${unknown.map((name) => `--${name}`).join(', ')} — refused rather than ignored, so nothing was written (known: ${KNOWN.names.map((name) => `--${name}`).join(' ')} --json)`,
      fix: "bun run scripts/new-error-code.ts X_PKG_WHAT_FAILED --package <pkg> --title '<one line>' --cause '<what usually makes it happen>' --fix '<command or edit>' [--dry-run]",
    }),
};

export function inputFrom(argv: readonly string[]): NewErrorCode {
  const args = parseScriptArgs(argv, KNOWN);
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

/** Another writer moved a file between this run's read and its write: refuse, write nothing. */
const changedUnderneath = (changed: readonly string[]): ScriptError =>
  new ScriptError({
    code: 'X_NEW_ERROR_CODE_INVALID',
    cause: `${changed.join(', ')} changed after this run read it — another run (or an editor) wrote there first, and writing now would drop that edit, so nothing was written`,
    fix: "bun run scripts/new-error-code.ts <CODE> --package <pkg> --title '…' --cause '…' --fix '…'   # rerun the same command: it plans against the files as they are now",
  });

/** One planned file edit: where, and the lines it adds that the file does not already hold. */
export interface PlannedEdit {
  readonly path: string;
  readonly added: readonly string[];
}

/** The lines of `after` that `before` lacks, in order — what a reader checks a dry run against. */
const addedLines = (before: string, after: string): string[] => {
  const had = new Set(before.split('\n'));
  return after.split('\n').filter((line) => !had.has(line));
};

/**
 * Plan every edit, then write them — or, under `--dry-run`, write nothing anywhere and return the
 * plan alone. Planning reads every file before anything is written, so a refusal writes nothing.
 */
export async function newErrorCode(root: string, argv: readonly string[]) {
  const input = inputFrom(argv);
  const dryRun = flagBool(parseScriptArgs(argv), 'dry-run');
  const snapshot: Snapshot = new Map();
  const planned = await planFiles(root, input, statusDecision(input.pkg, argv), snapshot);
  const edits = [
    { path: planned.errorsPath, text: planned.errorsTs },
    { path: WIKI_PAGE, text: planned.wiki },
    ...[planned.names, planned.fixes, planned.status].filter((edit) => edit !== undefined),
  ];
  const plan: PlannedEdit[] = [];
  for (const edit of edits) {
    plan.push({ path: edit.path, added: addedLines(snapshot.get(edit.path) ?? '', edit.text) });
  }
  if (!dryRun) await writePlanned(root, edits, snapshot, changedUnderneath);
  return {
    input,
    dryRun,
    planned: plan,
    written: dryRun ? [] : plan.map((edit) => edit.path),
    errorsPath: planned.errorsPath,
    fixesPath: planned.fixes?.path,
    statusPath: planned.status?.path,
  };
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const json = parseScriptArgs(argv).json;
  try {
    const result = await newErrorCode(repoRoot(), argv);
    const { input, fixesPath, statusPath } = result;
    const also = [
      fixesPath === undefined ? '' : `, its fix added to ${fixesPath}`,
      statusPath === undefined ? '' : `, its HTTP status decided in ${statusPath}`,
    ].join('');
    report(
      {
        ok: true,
        script: SCRIPT,
        summary: result.dryRun
          ? `dry run, nothing written: ${input.code} would be registered in ${result.errorsPath} and documented in ${WIKI_PAGE}${also}`
          : `${input.code} registered in ${result.errorsPath} and documented in ${WIKI_PAGE}${also} — the throw site is yours`,
        data: {
          code: input.code,
          dryRun: result.dryRun,
          written: result.written,
          planned: result.planned,
        },
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
