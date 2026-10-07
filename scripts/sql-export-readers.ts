#!/usr/bin/env bun

// Enforce that every `SQL_*` statement a package's public entry exports has a reader outside it.
//
// THE DEFECT THIS EXISTS FOR. A package's statements were exported beside its store "so the table
// can be applied the way `SQL_JOBS_TABLE` is" — and then every statement was, not only the DDL: the
// reserve, the settle, the insert, the claim. About thirty `SQL_*` names were public in 24.x with no
// caller anywhere but the module that runs them (plan 101, M7). Each was a semver-locked promise
// about a statement's exact text — a reworded `where` became a breaking change — kept for nobody.
//
// WHAT COUNTS AS A READER. Any `.ts`/`.tsx` file OUTSIDE the exporting package's directory whose
// comment-stripped text names the identifier as a word: another package, a script, either tracked
// app. A TEST outside the package counts for a `*_TABLE` only — a suite that applies a table needs
// its DDL — and never for any other statement: `SQL_CLAIM`, `SQL_OUTBOX_RELEASE` and
// `SQL_NOTIFY_INBOX_MARK_READ` stayed public in 24.x for one live test in `@ultimat3/cli`, and a test
// that runs a statement belongs in the statement's own package, where it needs no export. A mention
// in a comment does not count (`stripped` blanks comments and keeps every offset).
//
// WHAT THIS CANNOT SEE. An app outside this repository. The table statements a boot applies are
// read here by `@ultimat3/cli`'s `framework-schema.ts`, so they stay; an export kept for a reader
// this tree cannot see is a reader that has to be written down, and there is no allow-list on
// purpose — move the statement behind a function the reader calls instead.
//
//   bun run sql-export-readers  ·  bun run scripts/sql-export-readers.ts [--json]

// Reused, never re-spelled: the comment mask every other guard reads, offsets kept.
import { stripComments } from '../packages/core/src/source-mask';
import { flagBool, parseScriptArgs } from './lib/args';
import { type CorpusFile, corpus } from './lib/corpus';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { lineOf } from './lib/source-scan';

const SCRIPT = 'sql-export-readers';

/** A statement constant, as the packages spell one. */
const SQL_NAME = /^SQL_[A-Z0-9_]+$/;

/** `export { a, b as c } from …` and `export { a }` — the braces, with comments already blanked. */
const EXPORT_LIST = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g;

/** `export const SQL_X = …` written in the entry itself. */
const EXPORT_CONST = /\bexport\s+const\s+(SQL_[A-Z0-9_]+)\b/g;

/** A DDL statement — the one kind a test elsewhere may need, to apply it before it tests anything. */
const TABLE_NAME = /_TABLE$/;

/** `x.test.ts`, `x.live.test.ts`, `x.contract.test.tsx` — every suite suffix the gate runs. */
const TEST_FILE = /\.test\.tsx?$/;

/** Source no reader lives in: dependencies and build output. */
const NOT_SOURCE = /(?:^|\/)(?:node_modules|dist)\//;

export interface EntryFile {
  /** The package directory, `packages/<name>`. */
  readonly pkg: string;
  readonly file: CorpusFile;
}

export interface SqlExport {
  readonly pkg: string;
  readonly name: string;
  /** `path:line` of the export. */
  readonly at: string;
}

/** Every `SQL_*` name one entry file exports, with where it does. */
export function sqlExportsOf(entry: EntryFile): readonly SqlExport[] {
  const text = entry.file.stripped;
  const found: SqlExport[] = [];
  const add = (name: string, index: number): void => {
    if (!SQL_NAME.test(name)) return;
    found.push({ pkg: entry.pkg, name, at: `${entry.file.path}:${String(lineOf(text, index))}` });
  };
  for (const match of text.matchAll(EXPORT_LIST)) {
    for (const spec of (match[1] ?? '').split(',')) {
      // `a as b` exports `b`; a leading `type` modifier names nothing a statement could be.
      const exported =
        spec
          .trim()
          .split(/\s+as\s+/)
          .at(-1)
          ?.trim() ?? '';
      add(exported, match.index);
    }
  }
  for (const match of text.matchAll(EXPORT_CONST)) add(match[1] ?? '', match.index);
  return found;
}

/** The exports no file outside their own package names — a test counting for a table only. */
export function unreadSqlExports(
  entries: readonly EntryFile[],
  files: readonly CorpusFile[],
): readonly SqlExport[] {
  const exported = entries.flatMap(sqlExportsOf);
  return exported.filter(({ pkg, name }) => {
    const word = new RegExp(`\\b${name}\\b`);
    const testsCount = TABLE_NAME.test(name);
    return !files.some(
      (file) =>
        !file.path.startsWith(`${pkg}/`) &&
        (testsCount || !TEST_FILE.test(file.path)) &&
        word.test(file.stripped),
    );
  });
}

export function checkSqlExportReaders(input: {
  readonly entries: readonly EntryFile[];
  readonly unread: readonly SqlExport[];
}): readonly Finding[] {
  if (input.entries.length === 0) {
    return [
      {
        code: 'X_SQL_EXPORT_UNSCANNED',
        cause: 'no package entry file was read, so every SQL_* export would have read as used',
        fix: 'bun install && bun run sql-export-readers --json',
        at: 'packages/*/package.json',
      },
    ];
  }
  return input.unread.map((one) => ({
    code: 'X_SQL_EXPORT_UNREAD',
    cause: `${one.at} exports ${one.name}, and no file outside ${one.pkg}/ reads it${TABLE_NAME.test(one.name) ? '' : ' outside a test'} — a statement's exact text is then public API kept for nobody`,
    fix: `bun run sql-export-readers --json   # after deleting ${one.name} from the export list at ${one.at}; the module that runs it keeps its own export, and a test that runs it moves into ${one.pkg}/`,
    at: one.at,
  }));
}

/** `exports` targets that are source files, from one parsed `package.json`. */
export function entryPathsOf(manifest: unknown): readonly string[] {
  const exportsField =
    typeof manifest === 'object' && manifest !== null
      ? (manifest as { readonly exports?: unknown }).exports
      : undefined;
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (/\.tsx?$/.test(value)) found.add(value.replace(/^\.\//, ''));
      return;
    }
    if (typeof value === 'object' && value !== null)
      for (const inner of Object.values(value)) walk(inner);
  };
  walk(exportsField);
  return [...found].sort();
}

/** Every package's public entry files, read from the `exports` map each `package.json` declares. */
export async function collectEntries(
  root: string,
  files: readonly CorpusFile[],
): Promise<readonly EntryFile[]> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const entries: EntryFile[] = [];
  for (const manifestPath of new Bun.Glob('packages/*/package.json').scanSync({ cwd: root })) {
    const pkg = manifestPath.replace(/\/package\.json$/, '');
    const parsed: unknown = await Bun.file(`${root}/${manifestPath}`).json();
    for (const target of entryPathsOf(parsed)) {
      const file = byPath.get(`${pkg}/${target}`);
      if (file !== undefined) entries.push({ pkg, file });
    }
  }
  return entries.sort((a, b) => (a.file.path < b.file.path ? -1 : 1));
}

/** The tracked apps' sources: a reader there is a reader, though no corpus scope reads them. */
async function appFiles(root: string): Promise<readonly CorpusFile[]> {
  const paths = [
    ...new Bun.Glob('{examples,dummy}/*/**/*.{ts,tsx}').scanSync({ cwd: root }),
  ].filter((path) => !NOT_SOURCE.test(path));
  return Promise.all(
    paths.map(async (path) => {
      const source = await Bun.file(`${root}/${path}`).text();
      const stripped = stripComments(source);
      return { path, source, stripped, masked: stripped };
    }),
  );
}

/** The whole check over a tree: entries, readers, findings. */
export async function scanSqlExportReaders(root: string): Promise<{
  readonly entries: readonly EntryFile[];
  readonly unread: readonly SqlExport[];
  readonly findings: readonly Finding[];
}> {
  const source = await corpus(root, 'source');
  const entries = await collectEntries(root, source);
  const unread = unreadSqlExports(entries, [...source, ...(await appFiles(root))]);
  return { entries, unread, findings: checkSqlExportReaders({ entries, unread }) };
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const { entries, unread, findings } = await scanSqlExportReaders(repoRoot());
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `every SQL_* export of ${String(entries.length)} package entry file(s) has a reader outside its package`
          : `${String(findings.length)} SQL_* export(s) no file outside their package reads`,
      findings,
      data: { entries: entries.length, unread: flagBool(args, 'explain') ? unread : unread.length },
    },
    args.json,
  );
}
