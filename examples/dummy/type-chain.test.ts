/**
 * Proof case from docs/architecture/05-type-chain.md: "rename `excerpt` → `summary` in
 * `packages/db/src/schema/posts.ts` and change nothing else — the build must fail loudly
 * everywhere the value flows, never arrive silently as `undefined`."
 *
 * Two renames on a private copy of the app's sources, each typechecked with the real compiler, each
 * asserted on the exact set of files and diagnostics it breaks:
 *
 * - the COLUMN (`posts.ts`) reaches hops 1–4: row type → entity → repo → the view's
 *   `satisfies Record<PostViewKeys, unknown>` in `apps/web/app/posts/entity.ts`. It stops there by
 *   design: `PostView` is a declared schema, so the wire shape does not move with a column.
 * - the VIEW field (`entity.ts`) reaches hops 5+: the repo's mapper into the action `output`, the
 *   typed action call in a contract test, and the pages that render a post.
 *
 * No baseline run. The app's sources typecheck clean (0 diagnostics in this copy, 2026-11-13) — the
 * Postgres entity driver is built (`packages/entity/src/pg-driver.ts`) and `repo.ts` is on its real
 * surface — so every in-app diagnostic after a rename IS the rename's, and a red baseline is the
 * reference app's own `typecheck` step first (`bun run scripts/reference-app-gate.ts`). Both runs
 * share the copy's one `tsconfig.tsbuildinfo` (`composite` makes it incremental); by measurement
 * that saves nothing here — a rename at either root rechecks nearly the whole app.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no recursive copy, no symlink and no recursive remove, and the copy below needs all three.
import { cpSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';

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
/**
 * Where the rename happens, never the tracked file: the unit step runs its slices side by side, and
 * while this test held `posts.ts` renamed every seed in another process failed on `posts.summary`
 * (`X_INVARIANT_VIOLATED`). Under the app root so `@ultimat3/*` still resolves up to the repo's.
 */
const COPY = `${ROOT}/.x/type-chain-${String(process.pid)}`;
const SCHEMA_FILE = `${COPY}/packages/db/src/schema/posts.ts`;
const VIEW_FILE = `${COPY}/apps/web/app/posts/entity.ts`;

const RENAME_FROM = '    excerpt: text({ max: EXCERPT_MAX }),';
const RENAME_TO = '    summary: text({ max: EXCERPT_MAX }),';
const VIEW_FROM = '  excerpt: t.string.max(EXCERPT_MAX),';
const VIEW_TO = '  summary: t.string.max(EXCERPT_MAX),';

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
 * attribute to anything, and a config error would be counted as a hop. `harnessFault` refuses that
 * run first today — which makes this a second line of defence rather than a live bug, and a
 * predicate whose correctness depends on another function running first is one edit from being
 * neither.
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
  const proc = Bun.spawn([TSC, ...TSC_ARGS], { cwd: COPY, stdout: 'pipe', stderr: 'pipe' });
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

/** A workspace's `node_modules` is symlinks into the repo, kept as they are: only sources are copied. */
const WORKSPACE_ROOTS = ['apps', 'packages'] as const;

/** The app's sources under `COPY`, resolving exactly as the app does but for the one file renamed. */
async function copyApp(): Promise<void> {
  mkdirSync(COPY, { recursive: true });
  for (const entry of ['app.config.ts', 'bin', 'types', 'apps', 'guards', 'packages', 'scripts']) {
    cpSync(`${ROOT}/${entry}`, `${COPY}/${entry}`, {
      recursive: true,
      filter: (source) => !/\/(?:node_modules|dist|\.x)(?:\/|$)/.test(source),
    });
  }
  for (const workspace of WORKSPACE_ROOTS) {
    for (const name of readdirSync(`${ROOT}/${workspace}`)) {
      const modules = `${ROOT}/${workspace}/${name}/node_modules`;
      if (readdirSync(`${ROOT}/${workspace}/${name}`).includes('node_modules')) {
        symlinkSync(modules, `${COPY}/${workspace}/${name}/node_modules`);
      }
    }
  }
  // `@postly/db/seeds/dev` is the one app import `paths` does not name, so a workspace symlink
  // would answer it from the tracked schema and hide the seed's four diagnostics.
  const config = (await Bun.file(`${ROOT}/tsconfig.json`).json()) as {
    compilerOptions: { paths: Record<string, readonly string[]> };
  };
  config.compilerOptions.paths['@postly/db/seeds/dev'] = ['./packages/db/seeds/dev.ts'];
  await Bun.write(`${COPY}/tsconfig.json`, JSON.stringify(config));
}

// Pure, over fixtures: the three parsing and filtering decisions the proofs below rest on, none of
// which a compiler run can report on because they assert on its OUTPUT. Milliseconds.
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

  test('and is not an in-app diagnostic, so it can never be counted as a hop', () => {
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

/** A copy's file, with one line replaced for the length of `body` and put back after it. */
async function withEdit<T>(
  file: string,
  from: string,
  to: string,
  body: () => Promise<T>,
): Promise<T> {
  const pristine = await Bun.file(file).text();
  // If this fails, the fixture drifted from the rename, not the chain under test.
  expect(pristine).toContain(from);
  await Bun.write(file, pristine.replace(from, to));
  try {
    return await body();
  } finally {
    await Bun.write(file, pristine);
  }
}

/** What the rename broke: every in-app diagnostic of a run that really compiled. */
async function introducedBy(
  file: string,
  from: string,
  to: string,
): Promise<readonly Diagnostic[]> {
  const run = await withEdit(file, from, to, typecheckApp);
  // A compiler that did not run reports nothing, and every pin below would fail for a reason that
  // has nothing to do with the chain.
  expect(harnessFault(run)).toBe('');
  return run.diagnostics.filter(inApp);
}

/** File → how many diagnostics the rename earned there: the shape both proofs pin. */
const perFile = (found: readonly Diagnostic[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const d of found) counts[d.file] = (counts[d.file] ?? 0) + 1;
  return counts;
};

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

    await copyApp();
  });

  afterAll(() => {
    rmSync(COPY, { recursive: true, force: true });
  });

  test('excerpt → summary on the column, and nothing else, breaks hops 1–4 — never silently', async () => {
    const introduced = await introducedBy(SCHEMA_FILE, RENAME_FROM, RENAME_TO);

    // Pinned to the exact files the rename reaches today. A file dropping off this list without
    // the test changing is a fix silently going untested; a file this test doesn't know about
    // starting to break means a hop that was silent has become real — either way, update this
    // list on purpose, in the same commit, the same discipline `KNOWN_GAPS` in
    // `packages/cli/src/scaffold-typecheck-fixture.ts` uses for pinned compiler drift.
    //
    // `posts/repo.ts` spells the column three times — the view mapper, the feed projection, the
    // insert shape. The two `backfills/post-excerpts` files name it in the sweep's `source`
    // predicate, its row projection and its test's row builder (2026-08-23).
    // `scripts/test-setup.test.ts` joined 2026-08-24, when `SeedHandle.pick` started answering the
    // entity's own row type. `post-excerpts.test.ts` joined 2026-10-01: it stores posts and reads
    // their `excerpt` back through the typed handle.
    expect(new Set(introduced.map((d) => d.file))).toEqual(
      new Set([
        'apps/web/app/posts/backfills/post-excerpts.job.test.ts',
        'apps/web/app/posts/backfills/post-excerpts.test.ts',
        'apps/web/app/posts/backfills/post-excerpts.ts',
        'apps/web/app/posts/entity.ts',
        // `importRows()` writes a restored post back, `excerpt` included, and its job test builds one.
        'apps/web/app/posts/jobs.job.test.ts',
        'apps/web/app/posts/jobs/import-posts.ts',
        // `orgPosts`' paging test inserts 55 posts through the typed handle, `excerpt` included.
        'apps/web/app/posts/queries/org-posts.test.ts',
        'apps/web/app/posts/repo.ts',
        'apps/web/app/posts/repo.test.ts',
        // The subject-erase test seeds a post per member, and `excerpt` is required on an insert.
        'apps/web/app/settings/jobs/erase-member.test.ts',
        'packages/db/seeds/dev.ts',
        'scripts/test-setup.test.ts',
      ]),
    );
    // 22 as of 2026-08-24: 21, plus the one `scripts/test-setup.test.ts` now contributes.
    // 26 as of 2026-10-01: the sweep's handler writes `{ excerpt }` by primary key (2 more in
    // `post-excerpts.ts`), and `post-excerpts.test.ts` stores and reads the column (2).
    // 28 as of 2026-11-03: `import-posts.ts` writes `excerpt: ''` on a restored post (1), and
    // `posts/jobs.job.test.ts` builds a post row that names it (1).
    // 30 as of 2026-11-06: `settings/jobs/erase-member.test.ts` inserts two posts built with
    // `excerpt` (2), each insert its own diagnostic.
    // 31 as of 2026-11-11: `queries/org-posts.test.ts` inserts the posts it pages through (1).
    expect(introduced).toHaveLength(31);

    // `entity.ts`: the view's field list no longer names a real column (hop 4).
    expect(
      introduced.some(
        (d) => d.file === 'apps/web/app/posts/entity.ts' && d.message.includes("'excerpt'"),
      ),
    ).toBe(true);

    const counts = perFile(introduced);
    // `repo.ts`: the view mapper, the feed projection and the insert shape each name the column,
    // and the projection's THREE readers cascade off it, two diagnostics apiece — the column list
    // and the mapper it feeds (hop 2 → 3). The third reader is `publishedPage`, the public blog
    // index's page: one more reader of one projection is exactly the cascade this pins.
    expect(counts['apps/web/app/posts/repo.ts']).toBe(10);
    // `repo.test.ts`: a test seeding a row is an insert literal like any other (hop 1 → 2).
    expect(counts['apps/web/app/posts/repo.test.ts']).toBe(1);
    // `seeds/dev.ts`: raw insert literals no longer match the entity's columns (hop 1 → 2).
    expect(counts['packages/db/seeds/dev.ts']).toBe(4);
  }, 120_000);

  /**
   * Hops 5+, which the column rename above cannot reach: `PostView` is declared, not derived, so
   * the wire keeps `excerpt` until the VIEW changes. Renamed there, the field fails in the repo's
   * mapper into the action `output` (hop 5), in a contract test's typed action call (hop 7), and in
   * every page that renders a post off a query's output (hop 8) — `blog/page.tsx` through
   * `<PostCard>`'s props, the `posts/[id]` page in its own reads and in its test's `renderPage`.
   *
   * And the live feed (hop 9): `FeedRow` (`apps/web/app/feed/live.ts`) is DERIVED from
   * `PostSummary` since 2026-11, so the rename fails in the row's own key list and in the island
   * that renders the field — until then a hand-written wire type, and the rename reached the feed as
   * `undefined` at runtime.
   */
  test('excerpt → summary on the view breaks hops 5+ — the action output, its client, the pages', async () => {
    const introduced = await introducedBy(VIEW_FILE, VIEW_FROM, VIEW_TO);
    expect(perFile(introduced)).toEqual({
      // Hop 4, from the other side: `summary` is no column of `posts`.
      'apps/web/app/posts/entity.ts': 1,
      // Hop 5: the view mapper and the feed mapper return an object the `output` no longer has.
      'apps/web/app/posts/repo.ts': 2,
      // Hop 7: the typed `createPost` call's result has no `excerpt`.
      'apps/web/app/posts/actions.contract.test.ts': 1,
      // Hop 8: the pages that render a post.
      'apps/web/app/posts/[id]/page.tsx': 3,
      'apps/web/app/posts/[id]/page.test.ts': 4,
      'apps/web/site/blog/[slug]/page.tsx': 3,
      'apps/web/site/blog/page.tsx': 1,
      // Hop 9: the live feed's row names the field, and the island renders it.
      'apps/web/app/feed/live.ts': 1,
      'apps/web/app/feed/feed.island.tsx': 1,
    });
  }, 120_000);
});
