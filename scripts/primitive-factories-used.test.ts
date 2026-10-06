// The reference app uses every primitive factory: each `PRIMITIVE_FACTORIES` row is imported and
// called by `examples/dummy`, or pending with its reason. Split from `primitive-factories.test.ts`,
// which holds the other direction — every factory the tree declares has a row.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { PRIMITIVE_FACTORIES } from '@ultimat3/core';
import { usesFactory } from './lib/factory-uses';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Reads the real tree, so it runs on the repo-scan backstop (`REPO_SCAN_TIMEOUT_MS`).
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const read = (path: string): Promise<string> => Bun.file(`${repoRoot()}/${path}`).text();
const rowFor = (name: string) => PRIMITIVE_FACTORIES.find((entry) => entry.factory === name);

// The other direction: every factory the table lists is USED by the reference app. The table says
// what exists; `examples/dummy` is where idiom is decided (its CLAUDE.md), so a factory the app has
// never called is one whose idiomatic use nobody has had to get right (plan 101, sweep 10d, B16).

/** The reference app, as the scan reads it. */
const REFERENCE_APP = 'examples/dummy';

/**
 * Factories the reference app does not use YET, each with what using it idiomatically needs. A
 * ratchet, never an allow-list: a name here that the app now uses is a failure ("delete the row"),
 * so the list only shrinks. Adding a row is a reviewable diff with its reason beside it.
 */
export const PENDING_IN_REFERENCE_APP: Readonly<Record<string, string>> = {
  agentJob:
    'a queued run keeps no output (x_jobs has no result column), so a background agent is only real with an idempotent write tool, and Postly has no write an editor agent should make — a comment is not idempotent',
  webhook:
    'needs an org-owned endpoints entity with a sealed secret and a WebhookLedger the app persists — the framework ships no ledger table and memoryWebhookLedger() is dev-only',
};

/** Shipped app source: no tests (a test calling a factory proves nothing about the app), no deps. */
const appSources = async (): Promise<readonly { path: string; source: string }[]> => {
  const paths = [...new Bun.Glob(`${REFERENCE_APP}/**/*.{ts,tsx}`).scanSync({ cwd: repoRoot() })]
    .map((path) => path.split('\\').join('/'))
    .filter((path) => !path.includes('/node_modules/') && !path.includes('.test.'))
    .sort();
  return Promise.all(paths.map(async (path) => ({ path, source: await read(path) })));
};

const app = await appSources();
const usedBy = (row: { readonly factory: string; readonly pkg: string }): readonly string[] =>
  app.filter((file) => usesFactory(file.source, row.factory, row.pkg)).map((file) => file.path);

describe('unit · the reference app uses every primitive factory', () => {
  test('every factory in the table is called by examples/dummy, or pending with a reason', () => {
    for (const row of PRIMITIVE_FACTORIES) {
      if (row.factory in PENDING_IN_REFERENCE_APP || usedBy(row).length > 0) continue;
      expect.unreachable(
        `${row.pkg}'s ${row.factory}() is in PRIMITIVE_FACTORIES and nothing in ${REFERENCE_APP} imports and calls it — add one idiomatic use to the reference app (import { ${row.factory} } from '${row.pkg}'), with its test`,
      );
    }
  });

  test('a pending factory the app now uses is a stale row', () => {
    for (const [factory] of Object.entries(PENDING_IN_REFERENCE_APP)) {
      const row = rowFor(factory);
      if (row === undefined) {
        expect.unreachable(
          `PENDING_IN_REFERENCE_APP names ${factory}, which is not in PRIMITIVE_FACTORIES — delete the row in scripts/primitive-factories-used.test.ts`,
        );
      }
      const users = usedBy(row);
      if (users.length > 0) {
        expect.unreachable(
          `${factory}() is used by ${users.join(', ')} — delete its row from PENDING_IN_REFERENCE_APP in scripts/primitive-factories-used.test.ts`,
        );
      }
    }
  });

  test('the scan reads the app: a known use is found, and the test files are not read', () => {
    // Without this, a glob that matched nothing would leave every row "pending or used" by the
    // first test's logic only when the pending list happened to cover it — and fail it otherwise
    // with the wrong instruction.
    expect(usedBy({ factory: 'llm', pkg: '@ultimat3/ai' })).toContain(
      `${REFERENCE_APP}/apps/web/app/posts/actions.ts`,
    );
    expect(app.some((file) => file.path.includes('.test.'))).toBe(false);
  });
});

describe('unit · the use scan itself can fail', () => {
  test('a value import that is called is a use; a type import, an alias miss or no call is not', () => {
    const called =
      "import { agent, hive as fanOut } from '@ultimat3/ai';\nexport const h = fanOut({});";
    expect(usesFactory(called, 'hive', '@ultimat3/ai')).toBe(true);
    // Imported, never called.
    expect(usesFactory(called, 'agent', '@ultimat3/ai')).toBe(false);
    // The same name from another package is another function.
    expect(usesFactory(called, 'hive', '@ultimat3/jobs')).toBe(false);
    // A type import binds nothing callable, and a method of that name is not the factory.
    const typed = "import type { hive } from '@ultimat3/ai';\nconst x = thing.hive({});";
    expect(usesFactory(typed, 'hive', '@ultimat3/ai')).toBe(false);
    const inline = "import { type hive } from '@ultimat3/ai';\nhive({});";
    expect(usesFactory(inline, 'hive', '@ultimat3/ai')).toBe(false);
    // Named in a comment only — the call itself deleted.
    const prose =
      "import { hive } from '@ultimat3/ai';\n/** `hive()` fans out. */\n// hive() again\n";
    expect(usesFactory(prose, 'hive', '@ultimat3/ai')).toBe(false);
  });

  test('only an exported declaration initialised by the call counts — never text, dead code or a type', () => {
    const imported = "import { hive } from '@ultimat3/ai';\n";
    const counts = (body: string): boolean => usesFactory(imported + body, 'hive', '@ultimat3/ai');
    expect(counts('export const fan = hive({});')).toBe(true);
    expect(counts('export const fan: Action<I, O> = hive({});')).toBe(true);
    // A call spelled inside a string or a template literal.
    expect(counts("const s = 'export const fan = hive({})';")).toBe(false);
    expect(counts('const s = `\nexport const fan = hive({})\n`;')).toBe(false);
    // Dead code: never at module scope, never exported, so nothing registers it.
    expect(counts('if (false) {\n  hive({});\n}')).toBe(false);
    expect(counts('function never() {\n  return hive({});\n}')).toBe(false);
    expect(counts('hive({});')).toBe(false);
    // A type position: `typeof hive` names the function, it does not call it.
    expect(counts('export type Fan = ReturnType<typeof hive>;')).toBe(false);
    // A commented-out import binds nothing, so a call of that name is someone else's function.
    const commented = "// import { hive } from '@ultimat3/ai';\nexport const fan = hive({});";
    expect(usesFactory(commented, 'hive', '@ultimat3/ai')).toBe(false);
    // And a `//` inside a string is not a comment: the import after it still reads.
    const url = `const u = 'https://x';\n${imported}export const fan = hive({});`;
    expect(usesFactory(url, 'hive', '@ultimat3/ai')).toBe(true);
  });
});
