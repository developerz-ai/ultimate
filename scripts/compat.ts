#!/usr/bin/env bun

// The compat matrix's three commands, each run by `.github/workflows/compat.yml`: `prepare` a cell
// (its Postgres override or its Solid pin), `run` one gate part on it, and `file` the run's part
// documents as one `compat` issue per red cell, closed by the cell's own green run. Never a gate.
//
//   bun run scripts/compat.ts prepare --cell <id> [--compose-out <path>] [--json]
//   bun run scripts/compat.ts run --cell <id> --part <name> [--json]
//   bun run scripts/compat.ts file <part.json…> [--json]

import { renderFixShellArg } from '../packages/core/src/error-render';
import type { Runner } from './compat-cell';
import { prepareCell } from './compat-cell';
import { cellOf, loadCompatMatrix, partOf } from './compat-cells';
import { fileCompat } from './compat-file';
import type { PartDoc } from './compat-part';
import { runPart } from './compat-part';
import { flagString, parseScriptArgs } from './lib/args';
import type { Gh } from './lib/issue-ledger';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { ScriptError } from './lib/script-error';

const SCRIPT = 'compat';
const USAGE = 'bun run scripts/compat.ts run --cell bun-latest --part unit-1 --json';

const badArgs = (cause: string): ScriptError =>
  new ScriptError({ code: 'X_CLI_BAD_FLAG', cause, fix: USAGE });

const required = (value: string | undefined, flag: string): string => {
  if (value === undefined) throw badArgs(`--${flag} is required`);
  return value;
};

const partResult = (doc: PartDoc): ScriptResult => ({
  ok: doc.ok,
  script: SCRIPT,
  summary: `${doc.cell} ${doc.part} on Bun ${doc.bun}: ${doc.ok ? 'green' : `red, ${doc.failures.length} failing test(s)`}`,
  findings: [
    ...doc.failures.map(
      (failure): Finding => ({
        code: 'X_COMPAT_CELL_RED',
        cause: `${failure.file} > ${failure.test} failed on ${doc.cell}`,
        fix: doc.rerun,
        at: failure.file,
      }),
    ),
    ...(doc.ok || doc.failures.length > 0 ? [] : doc.findings),
  ],
  lines: [`  rerun: ${doc.rerun}`],
  data: doc,
});

/** A part's `--json` document read back: its `data` is the PartDoc `run` wrote. */
const partOfText = (text: string): PartDoc | undefined => {
  try {
    const data = (JSON.parse(text) as { data?: unknown } | null)?.data;
    const doc = data as Partial<PartDoc> | null | undefined;
    return typeof doc?.cell === 'string' &&
      typeof doc.part === 'string' &&
      typeof doc.ok === 'boolean' &&
      typeof doc.attempt === 'number' &&
      Array.isArray(doc.failures)
      ? (doc as PartDoc)
      : undefined;
  } catch {
    return undefined;
  }
};

async function fileCommand(paths: readonly string[], root: string, gh: Gh | undefined) {
  const matrix = await loadCompatMatrix(root);
  const docs: PartDoc[] = [];
  const unreadable: Finding[] = [];
  for (const path of paths) {
    const doc = partOfText(await Bun.file(path).text());
    if (doc !== undefined) docs.push(doc);
    else {
      unreadable.push({
        code: 'X_COMPAT_UNREADABLE',
        cause: `${path} is not a compat part document`,
        fix: `bun run scripts/compat.ts run --cell bun-latest --part unit-1 --json > ${renderFixShellArg(path, '<part.json>')}`,
      });
    }
  }
  const server = Bun.env['GITHUB_SERVER_URL'];
  const repo = Bun.env['GITHUB_REPOSITORY'];
  const id = Bun.env['GITHUB_RUN_ID'];
  const url = server && repo && id ? `${server}/${repo}/actions/runs/${id}` : undefined;
  const { red, filed, findings } = await fileCompat(matrix, docs, root, url, gh);
  return {
    ok: unreadable.length === 0 && findings.length === 0,
    script: SCRIPT,
    summary: `${docs.length} part document(s) read; ${matrix.cells.length} cell(s), ${red.length} red; ${filed.length} issue action(s)`,
    findings: [...unreadable, ...findings],
    lines: filed.map((line) => `  ${line}`),
    data: { red, filed },
  };
}

/** The command line, answered; every spawn and `gh` is injected by the tests. */
export async function compat(
  argv: readonly string[],
  root: string,
  deps: { readonly runner?: Runner; readonly gh?: Gh } = {},
): Promise<ScriptResult> {
  const args = parseScriptArgs(argv);
  const [command, ...rest] = args.positionals;
  if (command === 'file') return fileCommand(rest, root, deps.gh);
  if (command !== 'run' && command !== 'prepare') {
    throw badArgs(`unknown command ${command ?? '(none)'}: prepare, run or file`);
  }
  const matrix = await loadCompatMatrix(root);
  const cell = cellOf(matrix, required(flagString(args, 'cell'), 'cell'));
  if (command === 'prepare') {
    const composeOut = flagString(args, 'compose-out');
    const prepared = await prepareCell({
      root,
      cell,
      ...(composeOut === undefined ? {} : { composeOut }),
      ...(deps.runner === undefined ? {} : { runner: deps.runner }),
    });
    return { ...prepared, script: SCRIPT };
  }
  const part = partOf(matrix, required(flagString(args, 'part'), 'part'));
  const attempt = Number(Bun.env['GITHUB_RUN_ATTEMPT'] ?? '1');
  return partResult(
    await runPart({
      root,
      cell,
      part,
      attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : 1,
      ...(deps.runner === undefined ? {} : { runner: deps.runner }),
    }),
  );
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const json = argv.includes('--json');
  try {
    report(await compat(argv, repoRoot()), json);
  } catch (cause) {
    if (!(cause instanceof ScriptError)) throw cause;
    report({ ok: false, script: SCRIPT, summary: 'refused', findings: [cause.toFinding()] }, json);
  }
}
