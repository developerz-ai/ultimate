// Typechecks what `x new` and `x g` write, the way the user's own `tsc` will: real files on disk,
// the real workspace packages, the real compiler. A template that merely parses has not been
// checked — it has moved its failure from this gate to the first command the user runs.

import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { GenerateOptions } from './cmd-generate';
import { generate } from './cmd-generate';
import { planNewApp } from './cmd-new';
import type { Runner } from './exec';
import { exec } from './exec';
import type { GeneratedFile } from './templates';

/** Derived from this file, never from cwd, so the harness works from any working directory. */
export const workspaceRoot = (): string => resolve(import.meta.dir, '..', '..', '..');

/** The app the fixture scaffolds. Kebab, multi-word: single-word names hide casing bugs. */
export const FIXTURE_APP = 'ledger-demo';

/**
 * One realistic invocation of every generator, on top of `x new --example`. Names differ from
 * their feature on purpose: `x g query invoice --feature invoice` would collide with the entity
 * import, and a fixture that trips over its own naming stops testing the templates.
 */
export const FIXTURE_GENERATORS: readonly GenerateOptions[] = [
  { kind: 'resource', name: 'invoice' },
  { kind: 'entity', name: 'credit-note', feature: 'credit-note' },
  { kind: 'policy', name: 'credit-note', feature: 'credit-note' },
  { kind: 'action', name: 'send-invoice', feature: 'invoice' },
  { kind: 'mutator', name: 'rename-invoice', feature: 'invoice' },
  { kind: 'query', name: 'invoice-search', feature: 'invoice' },
  { kind: 'query', name: 'invoice-feed', feature: 'invoice', live: true },
  { kind: 'job', name: 'sweep-invoices', feature: 'invoice' },
  { kind: 'task', name: 'nightly-sweep', feature: 'invoice' },
  { kind: 'route', name: 'pricing', surface: 'site' },
  { kind: 'route', name: 'billing', surface: 'app' },
];

/** First write wins, exactly as `x g` and `x new` resolve a shared file such as `errors.ts`. */
const dedupe = (files: readonly GeneratedFile[]): readonly GeneratedFile[] => {
  const seen = new Map<string, GeneratedFile>();
  for (const file of files) if (!seen.has(file.path)) seen.set(file.path, file);
  return [...seen.values()];
};

/** The whole scaffolded surface: a new app, then every generator run inside it. */
export function scaffoldFixture(): readonly GeneratedFile[] {
  return dedupe([
    ...planNewApp({ name: FIXTURE_APP, example: true }),
    ...FIXTURE_GENERATORS.flatMap((options) => generate(options)),
  ]);
}

export interface TypeDiagnostic {
  /** Sandbox-relative path, or '' for a diagnostic the compiler raised about the project itself. */
  readonly file: string;
  readonly line: number;
  readonly code: string;
  readonly message: string;
}

const AT_FILE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const PROJECT_WIDE = /^error (TS\d+): (.*)$/;

/** Config errors carry no file, so both shapes are collected: a silent harness is a green lie. */
export function parseDiagnostics(output: string): readonly TypeDiagnostic[] {
  const found: TypeDiagnostic[] = [];
  for (const line of output.split('\n')) {
    const at = AT_FILE.exec(line);
    if (at !== null) {
      found.push({
        file: at[1] ?? '',
        line: Number.parseInt(at[2] ?? '0', 10),
        code: at[4] ?? '',
        message: at[5] ?? '',
      });
      continue;
    }
    const wide = PROJECT_WIDE.exec(line.trim());
    if (wide !== null)
      found.push({ file: '', line: 0, code: wide[1] ?? '', message: wide[2] ?? '' });
  }
  return found;
}

export interface KnownGap {
  readonly code: string;
  readonly file: RegExp;
  readonly message: RegExp;
  /** Who fixes it, and why the template cannot. */
  readonly owner: string;
}

/**
 * Diagnostics a template cannot fix, pinned one by one. Pinned, never ignored: `unexpectedIn`
 * fails on anything not listed here, and `staleGapsIn` fails when a listed entry stops
 * reproducing — so an entry cannot outlive the bug it describes.
 */
export const KNOWN_GAPS: readonly KnownGap[] = [
  {
    code: 'TS18048',
    file: /entity\.ts$/,
    message: /^'c\.[A-Za-z]\w*' is possibly 'undefined'\.$/,
    // `InvariantColumns` is an index-signature type, so `c.title` is `ColumnExpr | undefined`
    // under `noUncheckedIndexedAccess`. Every hand-written entity in `examples/dummy` reproduces
    // it identically: the fix is a column proxy typed from the entity's own columns, in
    // @ultimat3/entity — a different template cannot avoid it without dropping to `satisfies()`,
    // which would silently stop emitting the Postgres CHECK.
    owner: '@ultimat3/entity — type the invariant column proxy from the declared columns',
  },
];

const matches = (diagnostic: TypeDiagnostic, gap: KnownGap): boolean =>
  diagnostic.code === gap.code &&
  gap.file.test(diagnostic.file) &&
  gap.message.test(diagnostic.message);

/** Everything the gate refuses: a diagnostic no `KNOWN_GAPS` entry accounts for. */
export const unexpectedIn = (diagnostics: readonly TypeDiagnostic[]): readonly TypeDiagnostic[] =>
  diagnostics.filter((entry) => !KNOWN_GAPS.some((gap) => matches(entry, gap)));

/** Entries that no longer reproduce — the bug is fixed and the pin has to go. */
export const staleGapsIn = (diagnostics: readonly TypeDiagnostic[]): readonly KnownGap[] =>
  KNOWN_GAPS.filter((gap) => !diagnostics.some((entry) => matches(entry, gap)));

/** Written beside the app's own tsconfig so the gate inherits every flag the app ships with. */
const OVERLAY = 'tsconfig.scaffold-check.json';

/**
 * The one thing the sandbox may change about the generated project: where its imports resolve.
 * `@ultimat3/*` points at workspace source instead of a published tarball, and the app's own
 * workspace packages resolve without a `bun install` that a sealed test could never run.
 */
const overlay = (root: string, app: string): string =>
  `${JSON.stringify(
    {
      extends: './tsconfig.json',
      compilerOptions: {
        noEmit: true,
        paths: {
          '@ultimat3/*': [`${root}/packages/*/src`],
          [`@${app}/web/*`]: ['./apps/web/*'],
          [`@${app}/admin/*`]: ['./apps/admin/*'],
          [`@${app}/*`]: ['./packages/*/src'],
        },
      },
    },
    null,
    2,
  )}\n`;

export interface TypecheckOptions {
  readonly files?: readonly GeneratedFile[];
  readonly app?: string;
  readonly runner?: Runner;
  /** Leave the sandbox on disk. For debugging a red gate by hand, never for the gate itself. */
  readonly keep?: boolean;
}

export interface TypecheckReport {
  readonly dir: string;
  readonly fileCount: number;
  readonly diagnostics: readonly TypeDiagnostic[];
  readonly output: string;
}

export async function typecheckScaffold(options: TypecheckOptions = {}): Promise<TypecheckReport> {
  const root = workspaceRoot();
  const app = options.app ?? FIXTURE_APP;
  const files = options.files ?? scaffoldFixture();
  const dir = mkdtempSync(join(tmpdir(), 'x-scaffold-'));
  try {
    for (const file of files) await Bun.write(join(dir, file.path), file.contents);
    // The sandbox borrows the workspace's installed dependencies. The gate is about the
    // templates; whether a registry install succeeds is a different question, and a sealed
    // test cannot ask it.
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
    await Bun.write(join(dir, OVERLAY), overlay(root, app));
    const result = await (options.runner ?? exec)(
      [join(root, 'node_modules', '.bin', 'tsc'), '--noEmit', '--pretty', 'false', '-p', OVERLAY],
      { cwd: dir },
    );
    const output = [result.stdout, result.stderr].filter((part) => part.length > 0).join('\n');
    return { dir, fileCount: files.length, diagnostics: parseDiagnostics(output), output };
  } finally {
    if (options.keep !== true) rmSync(dir, { recursive: true, force: true });
  }
}

/** One diagnostic per line, in the shape `tsc` prints — a failed gate is a runnable bug report. */
export const formatDiagnostics = (diagnostics: readonly TypeDiagnostic[]): string =>
  diagnostics
    .map((entry) =>
      entry.file === ''
        ? `error ${entry.code}: ${entry.message}`
        : `${entry.file}:${entry.line} ${entry.code}: ${entry.message}`,
    )
    .join('\n');
