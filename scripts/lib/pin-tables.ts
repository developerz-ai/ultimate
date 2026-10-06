// Which ratchet tables `pin-raises` compares, and how a table that lives inside a SCRIPT is read at
// either end of a diff. A `*-pins.ts` module is pure data and is imported whole; a script is not —
// it imports `@ultimat3/cli` at run time, which a scratch copy cannot resolve — so only the named
// table's own declaration is lifted out of it.

import { balancedClose } from './balanced-paren';
import { pinRows } from './pin-rows';

/** Every `*-pins.ts` module: each export is a table. */
export const PIN_GLOB = 'scripts/lib/*-pins.ts';

export interface ScriptPinTable {
  readonly path: string;
  /** The one export that is a ratchet; the rest of the file is the rule that reads it. */
  readonly table: string;
  /** The table's rows, `<table>.<row>` → debt. `pinRows` when absent. */
  readonly rows?: (value: unknown) => ReadonlyMap<string, number>;
  /** 1-based line of a row in this file's source, 0 when it cannot be placed. */
  readonly line?: (source: string, row: string) => number;
}

/** `GATED_APPS.<dir>.<step>` → 1 for every step an app is allowed to fail. */
export function expectedRedRows(value: unknown): ReadonlyMap<string, number> {
  const rows = new Map<string, number>();
  if (!Array.isArray(value)) return rows;
  for (const app of value as readonly unknown[]) {
    if (typeof app !== 'object' || app === null) continue;
    const dir: unknown = Reflect.get(app, 'dir');
    const red: unknown = Reflect.get(app, 'expectedRed');
    if (typeof dir !== 'string' || typeof red !== 'object' || red === null) continue;
    for (const step of Object.keys(red)) rows.set(`GATED_APPS.${dir}.${step}`, 1);
  }
  return rows;
}

/** The `<step>:` line under the app whose `dir:` the row names. */
export function expectedRedLine(source: string, row: string): number {
  const rest = row.slice('GATED_APPS.'.length);
  const cut = rest.lastIndexOf('.');
  const dir = rest.slice(0, cut);
  const step = rest.slice(cut + 1);
  const lines = source.split('\n');
  const from = lines.findIndex((line) =>
    new RegExp(`\\bdir:\\s*['"]${RegExp.escape(dir)}['"]`).test(line),
  );
  if (from === -1) return 0;
  const key = new RegExp(`(?:^|[{,])\\s*(['"]?)${RegExp.escape(step)}\\1\\s*:`);
  const at = lines.findIndex((line, index) => index >= from && key.test(line));
  return at === -1 ? 0 : at + 1;
}

/**
 * `<table>.<file>` → `sites` for a `{ sites, why }` table. `pinRows` reads a row without a `count`
 * as a licence worth 1, so a row raised from 1 site to 5 would never read as a raise.
 */
export const sitesRows =
  (table: string) =>
  (value: unknown): ReadonlyMap<string, number> => {
    const rows = new Map<string, number>();
    if (typeof value !== 'object' || value === null) return rows;
    for (const [file, row] of Object.entries(value)) {
      const sites: unknown =
        typeof row === 'object' && row !== null ? Reflect.get(row, 'sites') : undefined;
      if (typeof sites === 'number') rows.set(`${table}.${file}`, sites);
    }
    return rows;
  };

/**
 * The tables whose headers say they may only shrink but which live outside `PIN_GLOB` — each was a
 * row an author could raise beside the debt it excused with no guard reading the number.
 */
export const SCRIPT_PIN_TABLES: readonly ScriptPinTable[] = [
  { path: 'scripts/doc-commands.ts', table: 'DOC_COMMAND_PINS' },
  { path: 'scripts/readme-fences-backlog.ts', table: 'README_FENCE_BACKLOG' },
  {
    path: 'scripts/lib/gated-apps.ts',
    table: 'GATED_APPS',
    rows: expectedRedRows,
    line: expectedRedLine,
  },
  { path: 'scripts/posix-relative.ts', table: 'BACKLOG' },
  {
    path: 'scripts/set-cookie-literals.ts',
    table: 'SET_COOKIE_PINS',
    rows: sitesRows('SET_COOKIE_PINS'),
  },
  {
    path: 'scripts/set-cookie-literals.ts',
    table: 'SET_COOKIE_RELAY_PINS',
    rows: sitesRows('SET_COOKIE_RELAY_PINS'),
  },
  { path: 'scripts/wiki-fences-backlog.ts', table: 'WIKI_FENCE_BACKLOG' },
];

/** Every file `pin-raises` reads: the glob, then each script holding one table. */
export const PIN_FILES: readonly string[] = [
  ...new Set([PIN_GLOB, ...SCRIPT_PIN_TABLES.map((one) => one.path)]),
];

/**
 * `export const <table> = <literal>;` lifted out of `source`, the type annotation dropped — or
 * `undefined` when the file declares no such table. The literal is walked with `balancedClose`, so a
 * `}` inside a string or a comment does not end it.
 */
export function tableDeclaration(source: string, table: string): string | undefined {
  const head = new RegExp(`export const ${RegExp.escape(table)}\\b[^=]*=\\s*`).exec(source);
  if (head === null) return undefined;
  const open = head.index + head[0].length;
  if (source[open] !== '{' && source[open] !== '[') return undefined;
  const close = balancedClose(source.replace(/[{[]/g, '(').replace(/[}\]]/g, ')'), open);
  if (close < 0) return undefined;
  return `export const ${table} = ${source.slice(open, close + 1)};\n`;
}

/** A script table's rows, read out of its loaded declaration. */
export const scriptTableRows = (
  spec: ScriptPinTable,
  loaded: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, number> =>
  spec.rows === undefined
    ? pinRows({ [spec.table]: loaded[spec.table] })
    : spec.rows(loaded[spec.table]);
