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

import { describe, expect, test } from 'bun:test';

// `Bun.spawn`, not `@ultimat3/cli`'s `exec`: this file sits at the app root, which has no
// `node_modules` of its own (only the workspace members under `apps/*`/`packages/*` do) — a
// framework-package import would resolve at typecheck time and fail at runtime.
const ROOT = import.meta.dir;
const TSC = `${ROOT}/../../node_modules/.bin/tsc`;
const SCHEMA_FILE = `${ROOT}/packages/db/src/schema/posts.ts`;

const RENAME_FROM = '    excerpt: text({ max: EXCERPT_MAX }),';
const RENAME_TO = '    summary: text({ max: EXCERPT_MAX }),';

interface Diagnostic {
  readonly file: string;
  readonly line: number;
  readonly code: string;
  readonly message: string;
}

const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

/** File + line + code + message: the same diagnostic reported twice is one diagnostic, not two. */
const key = (d: Diagnostic): string => `${d.file}:${d.line} ${d.code} ${d.message}`;

/** The real compiler, over the real app, exactly as `x verify`'s typecheck step runs it. */
async function typecheckApp(): Promise<readonly Diagnostic[]> {
  const proc = Bun.spawn([TSC, '--noEmit', '--pretty', 'false', '-p', 'tsconfig.json'], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const output = [stdout, stderr].filter((part) => part.length > 0).join('\n');
  const found: Diagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = DIAGNOSTIC.exec(line);
    if (match === null) continue;
    found.push({
      file: match[1] ?? '',
      line: Number.parseInt(match[2] ?? '0', 10),
      code: match[4] ?? '',
      message: match[5] ?? '',
    });
  }
  return found;
}

describe('type chain · the rename proof (docs/architecture/05-type-chain.md)', () => {
  test('excerpt → summary, and nothing else, breaks the build — never silently', async () => {
    const original = await Bun.file(SCHEMA_FILE).text();
    // If this fails, the fixture drifted from the rename below, not the chain under test.
    expect(original).toContain(RENAME_FROM);

    const before = await typecheckApp();
    const beforeKeys = new Set(before.map(key));

    // Sanity: the two files the rename is about to hit compile clean today. Otherwise a
    // diagnostic appearing "after" the rename could just be pre-existing noise wearing a new line
    // number, and the diff below would prove nothing.
    const touchedFiles = ['apps/web/app/posts/entity.ts', 'packages/db/seeds/dev.ts'];
    for (const file of touchedFiles) {
      expect(before.filter((d) => d.file === file)).toEqual([]);
    }

    let after: readonly Diagnostic[];
    try {
      await Bun.write(SCHEMA_FILE, original.replace(RENAME_FROM, RENAME_TO));
      after = await typecheckApp();
    } finally {
      // Always restored, even if typechecking throws — the rename is a fixture, not a change.
      await Bun.write(SCHEMA_FILE, original);
    }

    const introduced = after.filter((d) => !beforeKeys.has(key(d)));

    // The rename must surface as new, attributable failures — not vanish into whatever the app's
    // baseline already looked like.
    expect(introduced.length).toBeGreaterThan(0);

    // Pinned to the exact files the rename reaches today. A file dropping off this list without
    // the test changing is a fix silently going untested; a file this test doesn't know about
    // starting to break means a hop that was silent has become real — either way, update this
    // list on purpose, in the same commit, the same discipline `KNOWN_GAPS` in
    // `packages/cli/src/scaffold-typecheck.ts` uses for pinned compiler drift.
    expect(new Set(introduced.map((d) => d.file))).toEqual(new Set(touchedFiles));
    expect(introduced).toHaveLength(5);

    // `entity.ts`: the view's field list no longer names a real column (hop 4).
    expect(
      introduced.some(
        (d) => d.file === 'apps/web/app/posts/entity.ts' && d.message.includes("'excerpt'"),
      ),
    ).toBe(true);

    // `seeds/dev.ts`: raw insert literals no longer match the entity's columns (hop 1 → 2).
    expect(introduced.filter((d) => d.file === 'packages/db/seeds/dev.ts')).toHaveLength(4);
  }, 30_000);

  test('the schema file is restored exactly, pass or fail', async () => {
    const content = await Bun.file(SCHEMA_FILE).text();
    expect(content).toContain(RENAME_FROM);
    expect(content).not.toContain(RENAME_TO);
  });
});
