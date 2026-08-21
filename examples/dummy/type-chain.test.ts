/**
 * Proof case from docs/architecture/05-type-chain.md: "rename `excerpt` → `summary` in
 * `packages/db/src/schema/posts.ts` and change nothing else — the build must fail loudly
 * everywhere the value flows, never arrive silently as `undefined`."
 *
 * This performs the exact rename against the real files on disk, typechecks the app with the
 * real compiler before and after, and asserts on the *diff* — not a raw error count. The app
 * already carries pre-existing, separately-tracked drift (the Postgres entity driver — PR 5 —
 * leaves `packages/db`'s repo layer red on its own), so counting total diagnostics would prove
 * nothing about the rename specifically. The diff isolates exactly what the rename broke.
 *
 * Scope, honestly: this proves hops 1–4 (column → row type → entity → view schema, via the
 * `satisfies Record<PostViewKeys, unknown>` in `apps/web/app/posts/entity.ts`) are real,
 * inferred, and non-stale. Hops 5+ (view → action `output` → typed client → component) run
 * through `packages/db`'s repo/query layer, which PR 5 has not built yet — pinning those hops
 * here would either pin pre-existing breakage or pin nothing, neither of which is this test's job.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// `writeFileSync`, not `Bun.write`: the signal handlers below restore the fixture from inside a
// signal handler, which has no chance to await, and an unflushed async write is exactly the dirty
// checkout they exist to prevent. Bun ships no synchronous write.
import { writeFileSync } from 'node:fs';
// Node-specific and unavoidable: restoring a tracked file before the runner dies needs synchronous
// signal cleanup — `process.on`, `process.off` and `process.exit` — and Bun exposes no other way to
// intercept SIGINT/SIGTERM. Imported through `node:` rather than read off the global, per CLAUDE.md.
import process from 'node:process';

// `Bun.spawn`, not `@ultimat3/cli`'s `exec`: this file sits at the app root, which has no
// `node_modules` of its own (only the workspace members under `apps/*`/`packages/*` do) — a
// framework-package import would resolve at typecheck time and fail at runtime.
const ROOT = import.meta.dir;

// The repo root's compiler, and it has to be: `examples/dummy` is not a member of the root
// workspace — that list covers `examples/<app>/apps` and `examples/<app>/packages`, never the app
// root itself — so this directory has no `node_modules` and the `typescript` its own
// `package.json` pins is never installed. `x verify` runs `bunx tsc -b` from this same directory
// and `bunx` resolves upward to this exact binary, so today the gate and this test share a
// compiler: with different flags, and with nothing enforcing that they keep sharing one.
// `compiler` below is reported in every harness fault rather than pinned, so the day the app's own
// dependencies are installed the divergence is visible instead of silent.
const TSC = `${ROOT}/../../node_modules/.bin/tsc`;
const TSC_ARGS = ['--noEmit', '--pretty', 'false', '-p', 'tsconfig.json'] as const;
const SCHEMA_FILE = `${ROOT}/packages/db/src/schema/posts.ts`;

const RENAME_FROM = '    excerpt: text({ max: EXCERPT_MAX }),';
const RENAME_TO = '    summary: text({ max: EXCERPT_MAX }),';

interface Diagnostic {
  /** App-relative path, or `''` for a project-wide error the compiler raised about the config. */
  readonly file: string;
  readonly line: number;
  readonly code: string;
  readonly message: string;
}

interface TypecheckRun {
  /** Observed with this compiler: 0 = clean, 1 = diagnostics. Anything else is a harness fault. */
  readonly exitCode: number;
  readonly diagnostics: readonly Diagnostic[];
  readonly output: string;
}

const AT_FILE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const PROJECT_WIDE = /^error (TS\d+): (.*)$/;
const CLEAN = 0;
const DIAGNOSTICS_REPORTED = 1;

/** File + line + code + message: the same diagnostic reported twice is one diagnostic, not two. */
const key = (d: Diagnostic): string => `${d.file}:${d.line} ${d.code} ${d.message}`;

/**
 * Inside this app — `apps/…`, `packages/…`, never `../../packages/cli/…`. A rename in this app's
 * schema cannot reach a framework source (nothing in `packages/` imports Postly), so a diagnostic
 * out there is never this test's finding; and the compiler does not report the same set of them
 * twice. Eight identical `tsc --noEmit -p tsconfig.json` runs over an unchanged tree, at idle,
 * answered 117, 119 and 120 diagnostics — always the same 115 in-app ones, byte for byte, and 1 to
 * 4 TS6307 "not listed within the file list of project" lines about framework files reached
 * through the `node_modules` symlink. TypeScript 7 checks in parallel, and which importer it
 * blames for an unlisted file is a race between its workers, so a diff over the raw set reads that
 * race as a hop the rename broke. Contention only shifts the odds — this is not a timing flake and
 * a longer timeout would not have touched it.
 *
 * `d.file !== ''` first, and it is not cosmetic: a project-wide config error carries no path (see
 * `parseDiagnostics`), so a bare `..` test answered TRUE for the one class this filter cannot
 * attribute to anything. It would then enter `beforeKeys` and `alreadyFailing`, and a config error
 * the rename INTRODUCED could be excused as pre-existing. `harnessFault` refuses that run first
 * today — which makes this a second line of defence rather than a live bug, and a predicate whose
 * correctness depends on another function running first is one edit from being neither.
 */
const inApp = (d: Diagnostic): boolean => d.file !== '' && !d.file.startsWith('..');

/**
 * Both shapes, because a config error (TS5083 / TS6046 / TS18003) carries no `file(line,col):`
 * prefix. Parsing only the prefixed form would let a compiler that never opened a single source
 * file report zero diagnostics, and a baseline of zero is a baseline that proves nothing.
 */
function parseDiagnostics(output: string): readonly Diagnostic[] {
  const found: Diagnostic[] = [];
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
    if (wide !== null) {
      found.push({ file: '', line: 0, code: wide[1] ?? '', message: wide[2] ?? '' });
    }
  }
  return found;
}

/** Which compiler actually ran. Captured once, quoted in every harness fault. */
let compiler = 'unknown';

/** The real compiler, over the real app, close to how `x verify`'s typecheck step runs it. */
async function typecheckApp(): Promise<TypecheckRun> {
  const proc = Bun.spawn([TSC, ...TSC_ARGS], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  const output = [stdout, stderr].filter((part) => part.length > 0).join('\n');
  return { exitCode, diagnostics: parseDiagnostics(output), output };
}

/**
 * `''` when the compiler really compiled. Anything else is a fault in this harness, not a finding
 * about the type chain — and it says so with the exit code, the compiler and a runnable command,
 * because "expected 0 to be greater than 0" names nothing an agent can act on.
 */
function harnessFault(run: TypecheckRun): string {
  const reason = ((): string => {
    if (run.exitCode !== CLEAN && run.exitCode !== DIAGNOSTICS_REPORTED) {
      return `tsc exited ${run.exitCode}; only ${CLEAN} (clean) and ${DIAGNOSTICS_REPORTED} (diagnostics) mean it compiled`;
    }
    const wide = run.diagnostics.filter((d) => d.file === '');
    if (wide.length > 0) {
      const named = wide.map((d) => `${d.code} ${d.message}`).join('; ');
      return `tsc raised a project-wide error, so no source file was ever checked: ${named}`;
    }
    if (run.exitCode === DIAGNOSTICS_REPORTED && run.diagnostics.length === 0) {
      return 'tsc exited non-zero and printed nothing this harness could parse';
    }
    if (run.exitCode === CLEAN && run.diagnostics.length > 0) {
      return `tsc exited clean while this harness parsed ${run.diagnostics.length} diagnostics`;
    }
    return '';
  })();
  if (reason === '') return '';
  return [
    reason,
    `compiler: ${compiler} at ${TSC}`,
    `reproduce: cd examples/dummy && ${[TSC, ...TSC_ARGS].join(' ')}`,
    `raw output:\n${run.output.slice(0, 600)}`,
  ].join('\n');
}

const SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;
/** 128 + signal number — the shell's own convention for "killed by". */
const SIGNAL_EXIT: Readonly<Record<(typeof SIGNALS)[number], number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

/**
 * `finally` does not run on SIGINT, SIGTERM or a `process.exit` from anywhere else, and this test
 * mutates a tracked file in the checkout everyone works in — an interrupted run would leave
 * `posts.ts` renamed and the next reader would think that was the schema. Registered only around
 * the mutation window and released the moment it closes, so the handlers cannot outlive it.
 *
 * A temp copy is not an alternative: the file has to be inside the real `tsc` program for the
 * rename to break the type chain at all, which is the entire proof.
 */
function guardRestore(path: string, contents: string): () => void {
  const restore = (): void => {
    writeFileSync(path, contents);
  };
  const listeners = SIGNALS.map((signal) => {
    const listener = (): void => {
      restore();
      process.exit(SIGNAL_EXIT[signal]);
    };
    process.on(signal, listener);
    return { signal, listener } as const;
  });
  process.on('exit', restore);
  return (): void => {
    for (const { signal, listener } of listeners) process.off(signal, listener);
    process.off('exit', restore);
  };
}

/** Captured once, before anything can mutate it, so the restore assertion has a real reference. */
let pristine = '';

// Pure, over fixtures: the three parsing and filtering decisions the proof below rests on, none of
// which the 30-second run can report on because it asserts on their OUTPUT. Milliseconds.
describe('type chain · what the diff is computed over', () => {
  const at = (file: string, code = 'TS2339'): Diagnostic => ({ file, line: 1, code, message: 'x' });

  test('a project-wide error really does arrive with no path', () => {
    expect(
      parseDiagnostics('error TS6046: Argument for --module option must be a string.'),
    ).toEqual([
      {
        file: '',
        line: 0,
        code: 'TS6046',
        message: 'Argument for --module option must be a string.',
      },
    ]);
  });

  test('and is not an in-app diagnostic, so it can never be excused as pre-existing', () => {
    expect(inApp(at('', 'TS6046'))).toBe(false);
    expect(inApp(at('apps/web/app/posts/repo.ts'))).toBe(true);
    expect(inApp(at('../../packages/cli/src/bin.ts', 'TS6307'))).toBe(false);
  });

  test('and fails the run outright, which is the line of defence in front of that one', () => {
    const run: TypecheckRun = {
      exitCode: DIAGNOSTICS_REPORTED,
      diagnostics: [at('', 'TS6046')],
      output: 'error TS6046: x',
    };
    expect(harnessFault(run)).toContain('no source file was ever checked');
  });
});

describe('type chain · the rename proof (docs/architecture/05-type-chain.md)', () => {
  beforeAll(async () => {
    // A fresh clone with no install has no compiler here, and `Bun.spawn` would fail with an
    // ENOENT nobody can act on. Name the command that fixes it instead.
    const missing = (await Bun.file(TSC).exists())
      ? ''
      : `no compiler at ${TSC} — run: bun install (at the repo root)`;
    expect(missing).toBe('');

    const version = Bun.spawn([TSC, '--version'], { stdout: 'pipe', stderr: 'pipe' });
    compiler = (await new Response(version.stdout).text()).trim();
    await version.exited;

    pristine = await Bun.file(SCHEMA_FILE).text();
  });

  afterAll(async () => {
    // Exact equality, not `toContain`: the rename is a fixture, so the file has to come back byte
    // for byte whether the test below passed, failed, or was filtered out of this run entirely.
    expect(await Bun.file(SCHEMA_FILE).text()).toBe(pristine);
  });

  test('excerpt → summary, and nothing else, breaks the build — never silently', async () => {
    // If this fails, the fixture drifted from the rename below, not the chain under test.
    expect(pristine).toContain(RENAME_FROM);

    const before = await typecheckApp();
    // Before any diff: a compiler that did not run produces an empty baseline, and every
    // assertion below would then pass or fail for a reason that has nothing to do with the chain.
    expect(harnessFault(before)).toBe('');
    const beforeInApp = before.diagnostics.filter(inApp);
    const beforeKeys = new Set(beforeInApp.map(key));

    // Sanity: every file the rename is about to hit compiles clean today. Otherwise a
    // diagnostic appearing "after" the rename could just be pre-existing noise wearing a new line
    // number, and the diff below would prove nothing.
    //
    // `posts/repo.ts` joined the list when it was rewritten onto @ultimat3/entity's real surface:
    // it spells the column three times now — the view mapper, the feed projection, the insert
    // shape — where the builder API it used to call named no column at all.
    const touchedFiles = [
      'apps/web/app/posts/entity.ts',
      'apps/web/app/posts/repo.ts',
      'apps/web/app/posts/repo.test.ts',
      'packages/db/seeds/dev.ts',
    ];
    for (const file of touchedFiles) {
      expect(before.diagnostics.filter((d) => d.file === file)).toEqual([]);
    }

    /**
     * Files that already fail today. The diff below ignores them, and that is the same rule the
     * `touchedFiles` sanity check above states — just enforced instead of assumed.
     *
     * `apps/web/app/posts/repo.ts` is the case that forced it: it used to carry 18 errors of its
     * own (it called `.join()`, `.returning()` and friends that `@ultimat3/entity` has never had),
     * and the rename REWORDED one of them, because the message quotes the column list. A reworded
     * message is a new `key`, so a keyed diff reads it as introduced when nothing there compiled
     * before OR after. That file is repaired and pinned above now; the rule stays, because the
     * app's baseline is still red elsewhere and any of those messages can be reworded the same way.
     *
     * Deriving the set from the baseline rather than listing it keeps this honest — a file that
     * gets repaired drops out on its own, and its next real regression is caught.
     */
    const alreadyFailing = new Set(beforeInApp.map((d) => d.file));

    let after: TypecheckRun;
    const release = guardRestore(SCHEMA_FILE, pristine);
    try {
      await Bun.write(SCHEMA_FILE, pristine.replace(RENAME_FROM, RENAME_TO));
      after = await typecheckApp();
    } finally {
      // Always restored, even if typechecking throws — the rename is a fixture, not a change.
      await Bun.write(SCHEMA_FILE, pristine);
      release();
    }

    expect(harnessFault(after)).toBe('');
    const introduced = after.diagnostics.filter(
      (d) => inApp(d) && !beforeKeys.has(key(d)) && !alreadyFailing.has(d.file),
    );

    // The rename must surface as new, attributable failures — not vanish into whatever the app's
    // baseline already looked like.
    expect(introduced.length).toBeGreaterThan(0);

    // Pinned to the exact files the rename reaches today. A file dropping off this list without
    // the test changing is a fix silently going untested; a file this test doesn't know about
    // starting to break means a hop that was silent has become real — either way, update this
    // list on purpose, in the same commit, the same discipline `KNOWN_GAPS` in
    // `packages/cli/src/scaffold-typecheck.ts` uses for pinned compiler drift.
    expect(new Set(introduced.map((d) => d.file))).toEqual(new Set(touchedFiles));
    expect(introduced).toHaveLength(16);

    // `entity.ts`: the view's field list no longer names a real column (hop 4).
    expect(
      introduced.some(
        (d) => d.file === 'apps/web/app/posts/entity.ts' && d.message.includes("'excerpt'"),
      ),
    ).toBe(true);

    // `repo.ts`: the view mapper, the feed projection and the insert shape each name the column,
    // and the projection's THREE readers cascade off it, two diagnostics apiece — the column list
    // and the mapper it feeds (hop 2 → 3). The third reader is `publishedPage`, the public blog
    // index's page: one more reader of one projection is exactly the cascade this pins.
    expect(introduced.filter((d) => d.file === 'apps/web/app/posts/repo.ts')).toHaveLength(10);

    // `repo.test.ts`: a test seeding a row is an insert literal like any other (hop 1 → 2).
    expect(introduced.filter((d) => d.file === 'apps/web/app/posts/repo.test.ts')).toHaveLength(1);

    // `seeds/dev.ts`: raw insert literals no longer match the entity's columns (hop 1 → 2).
    expect(introduced.filter((d) => d.file === 'packages/db/seeds/dev.ts')).toHaveLength(4);
  }, 30_000);
});
