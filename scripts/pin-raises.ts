#!/usr/bin/env bun
// A ratchet pin that goes UP needs its reason in the same diff — `budget-raises`' rule, applied to
// every `scripts/lib/*-pins.ts` table and to the ratchets kept inside scripts (`PIN_FILES`). History
// shows why: `secret-compare` went 53 → 63, `node-import-pins` 3 → 12 and `proto-index-pins` 1 → 9
// with nothing on the row saying why, and a ratchet that only rises in silence is a list of
// findings nobody is asked to read.
//
// A row higher than at `origin/main`'s tip (absent there reads as 0) needs a `why:` on the row or in
// the comment block directly above it — and one the base did not already have for that row, since
// the sentence written for the old number licenses nothing about the new one. Else
// `X_PIN_RAISE_UNSTATED`. A checkout without `origin/main` is refused (`X_PIN_BASE_MISSING`).
//
//   bun run scripts/pin-raises.ts [--json]

// why: Bun has no recursive delete of its own, and the scratch copies must not outlive the run.
import { rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), and the base copy of a pins table has to be imported from a file.
import { tmpdir } from 'node:os';
import { parseScriptArgs } from './lib/args';
import { BASE_REF, baseRef, FETCH_MAIN, textAt } from './lib/base-ref';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { importPinSource, pinRows } from './lib/pin-rows';
import type { ScriptPinTable } from './lib/pin-tables';
import { PIN_GLOB, SCRIPT_PIN_TABLES, scriptTableRows, tableDeclaration } from './lib/pin-tables';
import { repoRoot } from './lib/run';

const SCRIPT = 'pin-raises';

export interface PinTableVersions {
  readonly path: string;
  readonly source: string;
  readonly now: ReadonlyMap<string, number>;
  /** `undefined` when the file does not exist at the base — every row is then a raise from 0. */
  readonly base: ReadonlyMap<string, number> | undefined;
  /** The file's text at the base, so a raise's `why:` can be compared with the one it had. */
  readonly baseSource?: string;
  /** Where a row sits in this file; `rowLine` when absent. */
  readonly line?: (source: string, row: string) => number;
}

export interface PinRaise {
  readonly path: string;
  readonly row: string;
  readonly line: number;
  readonly was: number;
  readonly now: number;
}

/** 1-based line of `<export>.<key>` in the source, or 0 when the row cannot be placed. */
export function rowLine(source: string, row: string): number {
  const dot = row.indexOf('.');
  const table = row.slice(0, dot);
  const key = row.slice(dot + 1);
  const lines = source.split('\n');
  const from = lines.findIndex((line) =>
    new RegExp(`\\bconst ${RegExp.escape(table)}\\b`).test(line),
  );
  if (from === -1) return 0;
  const asKey = new RegExp(`^\\s*(['"]?)${RegExp.escape(key)}\\1\\s*:`);
  const asPkg = new RegExp(`\\bpkg:\\s*['"]${RegExp.escape(key)}['"]`);
  const at = lines.findIndex(
    (line, index) => index >= from && (asKey.test(line) || asPkg.test(line)),
  );
  return at === -1 ? 0 : at + 1;
}

const COMMENT = /^(?:\/\/|\/\*|\*)/;

/**
 * What a row SAYS: the comment block directly above it plus, inside the row (key line through its
 * closing brace), every comment and every text from a `why:` on — never the count itself, which is
 * the one part a raise always changes. `undefined` when none of it carries a `why:`. Whitespace is
 * collapsed so a rewrap is not a new reason.
 */
export function whyStatement(source: string, line: number): string | undefined {
  if (line === 0) return undefined;
  const lines = source.split('\n');
  const head = lines[line - 1] ?? '';
  const indent = /^\s*/.exec(head)?.[0] ?? '';
  const said: string[] = [];
  for (let index = line - 2; index >= 0 && COMMENT.test((lines[index] ?? '').trim()); index -= 1) {
    said.unshift((lines[index] ?? '').trim());
  }
  const span = [head];
  if (/[{[]\s*$/.test(head)) {
    for (let index = line; index < lines.length; index += 1) {
      const text = lines[index] ?? '';
      span.push(text);
      if (text.startsWith(`${indent}}`) || text.startsWith(`${indent}]`)) break;
    }
  }
  for (const text of span) {
    const from = [text.indexOf('//'), text.search(/\bwhy:/)].filter((at) => at >= 0);
    if (from.length > 0) said.push(text.slice(Math.min(...from)).trim());
  }
  const statement = said.join(' ').replace(/\s+/g, ' ');
  return /\bwhy:/.test(statement) ? statement : undefined;
}

/** Stated: a `why:` is there now, and it is not the one the base had for the same row. */
const states = (table: PinTableVersions, row: string, line: number): boolean => {
  const now = whyStatement(table.source, line);
  if (now === undefined) return false;
  if (table.baseSource === undefined || table.base?.has(row) !== true) return true;
  const at = (table.line ?? rowLine)(table.baseSource, row);
  return whyStatement(table.baseSource, at) !== now;
};

/**
 * A table NEW since the base opens with its whole debt at once; a `why:` in the header above its
 * first export states all of it. Only a new table — a header cannot speak for a later raise.
 */
const headerStates = (table: PinTableVersions): boolean => {
  if (table.base !== undefined) return false;
  const firstExport = table.source.indexOf('export ');
  return /\bwhy:/.test(firstExport === -1 ? table.source : table.source.slice(0, firstExport));
};

export function checkPinRaises(tables: readonly PinTableVersions[]): readonly PinRaise[] {
  const raises: PinRaise[] = [];
  for (const table of tables) {
    if (headerStates(table)) continue;
    for (const [row, now] of table.now) {
      const was = table.base?.get(row) ?? 0;
      if (now <= was) continue;
      const line = (table.line ?? rowLine)(table.source, row);
      if (states(table, row, line)) continue;
      raises.push({ path: table.path, row, line, was, now });
    }
  }
  return raises.sort((a, b) => `${a.path}${a.row}`.localeCompare(`${b.path}${b.row}`));
}

export function raiseFinding(raise: PinRaise): Finding {
  const at = `${raise.path}:${raise.line}`;
  return {
    code: 'X_PIN_RAISE_UNSTATED',
    cause: `${raise.path} ${raise.row} rose ${raise.was}→${raise.now} since ${BASE_REF} with no why: of its own — none on the row, or only the one ${BASE_REF} already had, which was written for ${raise.was}`,
    fix: `edit ${at} — add // why: <the reason these sites cannot be fixed yet> on that row or directly above it, or fix the new sites and lower the row back to ${raise.was}`,
    at,
  };
}

/** One script's table at one end of the diff, or `undefined` when that text does not declare it. */
async function scriptRows(
  spec: ScriptPinTable,
  text: string | undefined,
  scratch: string,
  from: string,
): Promise<ReadonlyMap<string, number> | undefined> {
  const declared = text === undefined ? undefined : tableDeclaration(text, spec.table);
  if (declared === undefined) return undefined;
  return scriptTableRows(spec, await importPinSource(declared, scratch, from));
}

export async function readPinTables(root: string, base: string): Promise<PinTableVersions[]> {
  const scratch = `${tmpdir()}/ultimate-pin-raises-${process.pid}`;
  const tables: PinTableVersions[] = [];
  try {
    for (const path of [...new Bun.Glob(PIN_GLOB).scanSync({ cwd: root })].sort()) {
      const source = await Bun.file(`${root}/${path}`).text();
      const then = await textAt(root, base, path);
      tables.push({
        path,
        source,
        now: pinRows(await importPinSource(source, scratch, `${root}/${path}`)),
        base:
          then === undefined
            ? undefined
            : pinRows(await importPinSource(then, scratch, `${root}/${path}`)),
        ...(then === undefined ? {} : { baseSource: then }),
      });
    }
    for (const spec of SCRIPT_PIN_TABLES) {
      const from = `${root}/${spec.path}`;
      const source = await Bun.file(from).text();
      const then = await textAt(root, base, spec.path);
      tables.push({
        path: spec.path,
        source,
        // A script that no longer declares its table has no rows to raise; an absent one at the
        // base reads as a new table, exactly as a new `*-pins.ts` does.
        now: (await scriptRows(spec, source, scratch, from)) ?? new Map(),
        base: await scriptRows(spec, then, scratch, from),
        ...(then === undefined ? {} : { baseSource: then }),
        ...(spec.line === undefined ? {} : { line: spec.line }),
      });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return tables;
}

export function pinRaiseResult(
  tables: readonly PinTableVersions[],
  base: string | undefined,
): ScriptResult {
  if (base === undefined) {
    return {
      ok: false,
      script: SCRIPT,
      summary: `${BASE_REF} is not in this checkout and could not be fetched, so NO pin was compared`,
      findings: [
        {
          code: 'X_PIN_BASE_MISSING',
          cause: `${BASE_REF} is not in this checkout and the fetch failed, so no ratchet pin was compared against it`,
          fix: FETCH_MAIN,
        },
      ],
    };
  }
  const raises = checkPinRaises(tables);
  const rows = tables.reduce((sum, table) => sum + table.now.size, 0);
  return {
    ok: raises.length === 0,
    script: SCRIPT,
    summary:
      raises.length === 0
        ? `${tables.length} pin table(s), ${rows} row(s): every raise since ${base} states why`
        : `${raises.length} pin raise(s) since ${base} with no why:`,
    findings: raises.map(raiseFinding),
    data: { base, tables: tables.length, rows, raises },
  };
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const base = await baseRef(root);
  const tables = base === undefined ? [] : await readPinTables(root, base);
  report(pinRaiseResult(tables, base), args.json);
}
