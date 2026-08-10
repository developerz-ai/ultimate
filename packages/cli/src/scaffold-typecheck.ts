// Typechecks what `x new` and `x g` write, the way the user's own `tsc` will: real files on disk,
// the real workspace packages, the real compiler. A template that merely parses has not been
// checked — it has moved its failure from this gate to the first command the user runs.

// `node:` and not Bun: Bun has no API for a temporary directory (`mkdtempSync` + `tmpdir`), for a
// symlink (`symlinkSync`, how the sandbox borrows the workspace's node_modules), or for a
// recursive delete (`rmSync`). `node:path` comes with them — `Bun.write` takes the joined path,
// but only `resolve`/`sep` can prove that path stayed inside the sandbox.
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { ScaffoldPathEscapeError } from './errors';
import type { Runner } from './exec';
import { exec } from './exec';
import { FIXTURE_APP, scaffoldFixture } from './scaffold-fixture';
import type { GeneratedFile } from './templates';

/** Derived from this file, never from cwd, so the harness works from any working directory. */
export const workspaceRoot = (): string => resolve(import.meta.dir, '..', '..', '..');

export interface TypeDiagnostic {
  /** Sandbox-relative path, or '' for a diagnostic the compiler raised about the project itself. */
  readonly file: string;
  readonly line: number;
  readonly code: string;
  readonly message: string;
}

const AT_FILE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const PROJECT_WIDE = /^error (TS\d+): (.*)$/;

/**
 * Config errors carry no file, so both shapes are collected: a silent harness is a green lie.
 * Split on `\r?\n`, because a trailing `\r` lands inside the message capture and no `KNOWN_GAPS`
 * entry would match it — a CRLF `tsc` would turn every pinned gap into an unexplained failure.
 */
export function parseDiagnostics(output: string): readonly TypeDiagnostic[] {
  const found: TypeDiagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
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
  /** `ScaffoldVariant.name`. A pin bought by one invocation may not excuse another. */
  readonly variant: string;
  readonly code: string;
  /** Exact sandbox-relative path. A pattern would absolve the same bug in a file nobody pinned. */
  readonly file: string;
  /** Exact `tsc` message. Matched literally so a near-miss regression is not absorbed. */
  readonly message: string;
  /** Who fixes it, and why the template cannot. */
  readonly owner: string;
}

// `InvariantColumns` is an index-signature type, so `c.title` is `ColumnExpr | undefined` under
// `noUncheckedIndexedAccess`. Every hand-written entity in `examples/dummy` reproduces it
// identically: the fix is a column proxy typed from the entity's own columns, in @ultimat3/entity
// — a different template cannot avoid it without dropping to `satisfies()`, which would silently
// stop emitting the Postgres CHECK.
//
// Measured, not guessed: no open-keyed form avoids the `| undefined` (index signature, `Record`,
// and a mapped type over `string` or a template-literal pattern all produce it), and typing the
// proxy from `columns` only reaches `c` when the element of `invariants:` is itself
// context-sensitive. `invariant(name, build)` is a *call*, which TypeScript checks before
// `entity()`'s own `C` is fixed, so `K` falls back to `string` and nothing changes. Making it
// reach means changing the shape of `invariants:` — a documented primitive, so a major.
const INVARIANT_PROXY =
  '@ultimat3/entity — type the invariant column proxy from the declared columns (needs a major: ' +
  'the `invariants:` element shape has to become context-sensitive)';

/** Every entity the fixture generates. Each one declares the same two invariants. */
const FIXTURE_ENTITIES = [
  'apps/web/app/credit-note/entity.ts',
  'apps/web/app/invoice/entity.ts',
  'apps/web/app/post/entity.ts',
] as const;

/**
 * Diagnostics a template cannot fix, pinned one occurrence at a time. Pinned, never ignored:
 * `unexpectedIn` fails on anything not listed here — including a second copy of a listed
 * diagnostic, because each entry is consumed by exactly one match — and `staleGapsIn` fails when
 * a listed entry stops reproducing, so an entry cannot outlive the bug it describes.
 */
export const KNOWN_GAPS: readonly KnownGap[] = FIXTURE_ENTITIES.flatMap((file) =>
  ["'c.title' is possibly 'undefined'.", "'c.price' is possibly 'undefined'."].map(
    (message): KnownGap => ({
      variant: 'x new',
      code: 'TS18048',
      file,
      message,
      owner: INVARIANT_PROXY,
    }),
  ),
);

/** The pins one invocation may spend. Another variant's pins are not its to spend. */
export const gapsFor = (variant: string): readonly KnownGap[] =>
  KNOWN_GAPS.filter((gap) => gap.variant === variant);

const matches = (diagnostic: TypeDiagnostic, gap: KnownGap): boolean =>
  diagnostic.code === gap.code &&
  diagnostic.file === gap.file &&
  diagnostic.message === gap.message;

export interface GapPartition {
  /** Diagnostics no unconsumed `KNOWN_GAPS` entry accounts for. */
  readonly unexpected: readonly TypeDiagnostic[];
  /** Entries that found no match — the bug is fixed and the pin has to go. */
  readonly stale: readonly KnownGap[];
}

/**
 * One pass, first-fit, each pin spent once. Counting matters: two occurrences of a diagnostic
 * pinned once means a new regression is hiding behind an old bug, so the surplus is unexpected.
 */
export function partitionDiagnostics(
  diagnostics: readonly TypeDiagnostic[],
  gaps: readonly KnownGap[] = KNOWN_GAPS,
): GapPartition {
  const budget = gaps.map((gap) => ({ gap, spent: false }));
  const unexpected: TypeDiagnostic[] = [];
  for (const entry of diagnostics) {
    const slot = budget.find((pin) => !pin.spent && matches(entry, pin.gap));
    if (slot === undefined) unexpected.push(entry);
    else slot.spent = true;
  }
  return { unexpected, stale: budget.filter((pin) => !pin.spent).map((pin) => pin.gap) };
}

/** Everything the gate refuses: a diagnostic no unconsumed `KNOWN_GAPS` entry accounts for. */
export const unexpectedIn = (
  diagnostics: readonly TypeDiagnostic[],
  gaps: readonly KnownGap[] = KNOWN_GAPS,
): readonly TypeDiagnostic[] => partitionDiagnostics(diagnostics, gaps).unexpected;

/** Entries that no longer reproduce — the bug is fixed and the pin has to go. */
export const staleGapsIn = (
  diagnostics: readonly TypeDiagnostic[],
  gaps: readonly KnownGap[] = KNOWN_GAPS,
): readonly KnownGap[] => partitionDiagnostics(diagnostics, gaps).stale;

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

/**
 * `GeneratedFile.path` is documented as relative-POSIX, not enforced as it. A `..` segment would
 * put template output on the developer's real disk, so the sandbox proves containment before it
 * writes rather than after.
 */
export function sandboxPath(dir: string, path: string): string {
  const target = resolve(dir, path);
  if (target !== dir && !target.startsWith(`${dir}${sep}`))
    throw new ScaffoldPathEscapeError({ path, dir });
  return target;
}

export async function typecheckScaffold(options: TypecheckOptions = {}): Promise<TypecheckReport> {
  const root = workspaceRoot();
  const app = options.app ?? FIXTURE_APP;
  const files = options.files ?? scaffoldFixture();
  const dir = mkdtempSync(join(tmpdir(), 'x-scaffold-'));
  try {
    for (const file of files) await Bun.write(sandboxPath(dir, file.path), file.contents);
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
