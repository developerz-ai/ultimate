// The CODE half of `error-contract.ts`: which codes a repo declares, whether each one is readable,
// and what the reference page owes them. `error-contract.test.ts` reached the 500-line ceiling
// again — the same split `error-contract-paths.test.ts` already made, along the other seam: that
// file keeps "is this fix an instruction", this one keeps "which codes exist, and can we read them".
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkErrorCodeDocs,
  checkErrorCodeRegistry,
  checkErrorCodeResolution,
  collectDeclaredCodes,
  documentedCodes,
  liveCodes,
  RESERVED_HEADING,
} from './error-contract';

describe('documentedCodes', () => {
  test('reads every code the page names, including a shared row', () => {
    const page = '| `X_A` | means | cause | fix |\n| `X_B` / `X_C` | means | cause | fix |\n';
    expect([...documentedCodes(page)].sort()).toEqual(['X_A', 'X_B', 'X_C']);
  });
});

describe('the code checks, over a repo', () => {
  let root = '';

  const write = async (path: string, text: string): Promise<void> => {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'error-codes-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // One walk answers "which codes exist?" for the docs check and for the framework's own
  // manifest. A collector that read one filename per package would leave both blind to the same
  // codes, and the manifest would claim a completeness it never had.
  test('collectDeclaredCodes reads every source file, not just a package registry', async () => {
    await write('packages/db/src/errors.ts', "export const DB_ERROR_CODES = ['X_B'] as const;\n");
    await write('packages/db/src/pool.ts', "throw new E({ code: 'X_C', fix: 'x db status' });\n");
    await write('scripts/gate.ts', "throw new E({ code: 'X_A', fix: 'bun run gate' });\n");
    expect(await collectDeclaredCodes(root)).toEqual([
      { code: 'X_A', at: 'scripts/gate.ts', line: 1 },
      { code: 'X_B', at: 'packages/db/src/errors.ts', line: 1 },
      { code: 'X_C', at: 'packages/db/src/pool.ts', line: 1 },
    ]);
  });

  test('collectDeclaredCodes skips tests and generated declarations', async () => {
    await write('packages/db/src/errors.ts', "export const DB_ERROR_CODES = ['X_A'] as const;\n");
    await write('packages/db/src/pool.test.ts', "expect(e.code).toBe('X_INVENTED');\n");
    await write('packages/db/src/errors.d.ts', "export declare const C: 'X_DECLARED';\n");
    expect(await collectDeclaredCodes(root)).toEqual([
      { code: 'X_A', at: 'packages/db/src/errors.ts', line: 1 },
    ]);
  });

  // A package declares its codes in its registry, so that is the declaration however many files
  // throw it — and `aaa.ts` proves the rule is not just "the alphabetically first path".
  test('collectDeclaredCodes prefers the registry over any throw site', async () => {
    await write('packages/db/src/aaa.ts', "throw new E({ code: 'X_A', fix: 'x db status' });\n");
    await write('packages/db/src/errors.ts', "\nexport const DB_ERROR_CODES = ['X_A'] as const;\n");
    await write('packages/db/src/pool.ts', "throw new E({ code: 'X_A', fix: 'x db status' });\n");
    expect(await collectDeclaredCodes(root)).toEqual([
      { code: 'X_A', at: 'packages/db/src/errors.ts', line: 2 },
    ]);
  });

  // Without this the owner of a code eleven packages throw is whichever one sorts first — how the
  // manifest came to call `X_NOT_IMPLEMENTED` storage's when every borrower says it is core's.
  test('collectDeclaredCodes skips past a registry that says the code is borrowed', async () => {
    await write(
      'packages/admin/src/errors.ts',
      "export const ADMIN_BORROWED_ERROR_CODES = ['X_A'] as const;\n",
    );
    await write(
      'packages/core/src/error-codes.ts',
      "export const CORE_ERROR_TITLES = {\n  X_A: 'not implemented',\n};\n",
    );
    expect(await collectDeclaredCodes(root)).toEqual([
      { code: 'X_A', at: 'packages/core/src/error-codes.ts', line: 2 },
    ]);
  });

  // A package over the 500-line ceiling splits its registry in two, and the half left behind is
  // still called `errors.ts` while declaring no codes at all. Under the old filename test it was
  // a registry, so `X_A` — core's, borrowed here — was attributed to `admin`, whose path sorts
  // first. The table is what makes a file the registry, not what it is named.
  test('collectDeclaredCodes ignores a classes-only errors.ts', async () => {
    await write(
      'packages/admin/src/error-codes.ts',
      "export const ADMIN_BORROWED_ERROR_CODES = ['X_A'] as const;\n",
    );
    await write('packages/admin/src/errors.ts', "super({ code: 'X_A', fix: 'x help' });\n");
    await write(
      'packages/core/src/error-codes.ts',
      "export const CORE_ERROR_TITLES = {\n  X_A: 'not implemented',\n};\n",
    );
    expect(await collectDeclaredCodes(root)).toEqual([
      { code: 'X_A', at: 'packages/core/src/error-codes.ts', line: 2 },
    ]);
  });

  // `Bun.Glob` yields in directory order, so "whichever file the walk reached first" is a
  // different answer on a different filesystem — and the framework manifest, which commits this
  // path and gates on the diff, would drift between two machines reading the same tree.
  test('collectDeclaredCodes settles two throw sites by path, then line', async () => {
    await write('packages/db/src/pool.ts', "throw new E({ code: 'X_A', fix: 'x db status' });\n");
    await write(
      'packages/db/src/aaa.ts',
      "\n\nthrow new E({ code: 'X_A', fix: 'x db status' });\n",
    );
    await write('packages/db/src/aaa/deep.ts', "throw new E({ code: 'X_A', fix: 'x db a' });\n");
    expect(await collectDeclaredCodes(root)).toEqual([
      { code: 'X_A', at: 'packages/db/src/aaa.ts', line: 3 },
    ]);
  });

  // #277, end to end: `collectDeclaredCodes` is the one answer every reader takes — the manifest,
  // this page's coverage rule, `bun run gate-codes` — so resolving the const in the scanner is
  // what makes a DRY declaration visible to all three at once.
  test('collectDeclaredCodes resolves a code declared as a module-scope const', async () => {
    await write(
      'scripts/package-map-graph.ts',
      "const STALE = 'X_DOC_PACKAGE_GRAPH_STALE';\n" +
        "throw new UltimateError({ code: STALE, fix: 'bun run manifest' });\n",
    );
    expect(await collectDeclaredCodes(root)).toEqual([
      { code: 'X_DOC_PACKAGE_GRAPH_STALE', at: 'scripts/package-map-graph.ts', line: 2 },
    ]);
  });

  test('checkErrorCodeDocs demands a row for a const-declared code too', async () => {
    await write(
      'scripts/graph.ts',
      "const STALE = 'X_DOC_STALE';\nthrow new E({ code: STALE, fix: 'bun run manifest' });\n",
    );
    await write('wiki/Error-Codes.md', 'no codes here\n');
    const [finding, ...rest] = await checkErrorCodeDocs(root, 'wiki/Error-Codes.md');
    expect(rest).toEqual([]);
    expect(finding?.cause).toContain('X_DOC_STALE is declared at scripts/graph.ts:2');
  });

  test('checkErrorCodeDocs reports a declared code the page does not name', async () => {
    await write(
      'packages/db/src/errors.ts',
      "export const DB_ERROR_CODES = ['X_A', 'X_B'] as const;\n",
    );
    await write('wiki/Error-Codes.md', '| `X_A` | means | cause | fix |\n');
    const [finding, ...rest] = await checkErrorCodeDocs(root, 'wiki/Error-Codes.md');
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_ERROR_CODE_UNDOCUMENTED');
    expect(finding?.cause).toContain('X_B is declared at packages/db/src/errors.ts:1');
    expect(finding?.fix).toBe(
      'add a row for X_B to wiki/Error-Codes.md, with its cause and the command that fixes it',
    );
  });

  test('checkErrorCodeDocs passes when every declared code is on the page', async () => {
    await write('packages/db/src/errors.ts', "export const DB_ERROR_CODES = ['X_A'] as const;\n");
    await write('wiki/Error-Codes.md', '| `X_A` | means | cause | fix |\n');
    expect(await checkErrorCodeDocs(root, 'wiki/Error-Codes.md')).toEqual([]);
  });

  // A missing reference page must fail loudly: silently passing would make an empty repo the
  // best-scoring one, which is the shape of every gate that reads green over nothing.
  test('checkErrorCodeDocs fails when the reference page is absent', async () => {
    await write('packages/db/src/errors.ts', "export const DB_ERROR_CODES = ['X_A'] as const;\n");
    const [finding] = await checkErrorCodeDocs(root, 'wiki/Error-Codes.md');
    expect(finding?.code).toBe('X_ERROR_CODE_UNDOCUMENTED');
    expect(finding?.cause).toContain('does not exist');
  });

  test('one finding per code, however many files declare it', async () => {
    await write('packages/db/src/errors.ts', "export const DB_ERROR_CODES = ['X_A'] as const;\n");
    await write('packages/db/src/thing.ts', "throw new E({ code: 'X_A', fix: 'x help' });\n");
    await write('wiki/Error-Codes.md', 'no codes here\n');
    expect(await checkErrorCodeDocs(root, 'wiki/Error-Codes.md')).toHaveLength(1);
  });

  // The other half of #277, and the reason resolution alone is not enough: a scanner that cannot
  // read an identifier must SAY so. Skipping it silently is what let a real code ship with no
  // manifest row, no wiki row and no `x errors explain` answer, under a green gate.
  test('checkErrorCodeResolution reports a code behind a name it cannot resolve', async () => {
    await write(
      'scripts/graph.ts',
      "import { STALE } from './codes';\nthrow new E({ code: STALE, fix: 'bun run manifest' });\n",
    );
    const [finding, ...rest] = await checkErrorCodeResolution(root);
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_ERROR_CODE_UNRESOLVED');
    expect(finding?.cause).toContain('STALE');
    expect(finding?.fix).toContain('scripts/graph.ts:2');
    expect(finding?.at).toBe('scripts/graph.ts:2');
  });

  test('checkErrorCodeResolution passes on a const the same file declares', async () => {
    await write(
      'scripts/graph.ts',
      "const STALE = 'X_DOC_STALE';\nthrow new E({ code: STALE, fix: 'bun run manifest' });\n",
    );
    expect(await checkErrorCodeResolution(root)).toEqual([]);
  });

  // A fixture naming a code it does not own is the subject of a test, never a declaration — the
  // same line `collectDeclaredCodes` already draws around tests and generated declarations.
  test('checkErrorCodeResolution skips tests and generated declarations', async () => {
    await write('packages/db/src/pool.test.ts', 'expect(e).toEqual({ code: STALE });\n');
    await write('packages/db/src/pool.d.ts', 'export declare const e: { code: STALE };\n');
    expect(await checkErrorCodeResolution(root)).toEqual([]);
  });

  const page = (body: string): Promise<void> => write('wiki/Error-Codes.md', body);

  test('checkErrorCodeRegistry reports a live row no package registers', async () => {
    await page('| `X_A` | means | cause | fix |\n| `X_GHOST` | means | cause | fix |\n');
    const [finding, ...rest] = await checkErrorCodeRegistry(
      root,
      'wiki/Error-Codes.md',
      new Set(['X_A']),
    );
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_ERROR_CODE_UNREGISTERED');
    expect(finding?.cause).toContain('X_GHOST');
    expect(finding?.fix).toContain('src/errors.ts');
    expect(finding?.fix).toContain(RESERVED_HEADING);
    expect(finding?.at).toBe('wiki/Error-Codes.md');
  });

  // The whole point of the partition: a reserved name is documented on purpose, and a rule that
  // demanded a registration for it would delete the row instead of the ambiguity.
  test('checkErrorCodeRegistry exempts everything below the reserved heading', async () => {
    await page(`| \`X_A\` | means | cause | fix |\n\n${RESERVED_HEADING}\n\n| \`X_GHOST\` | x |\n`);
    expect(await checkErrorCodeRegistry(root, 'wiki/Error-Codes.md', new Set(['X_A']))).toEqual([]);
  });

  // `checkErrorCodeDocs` already reports the missing page, with the fix for creating it. A second
  // finding for the same file would double every count and name no new work.
  test('checkErrorCodeRegistry leaves the missing-page finding to the docs half', async () => {
    expect(await checkErrorCodeRegistry(root, 'wiki/Error-Codes.md', new Set())).toEqual([]);
  });

  test('checkErrorCodeRegistry reports each ghost once, sorted', async () => {
    await page('`X_Z` `X_A` `X_Z`\n');
    expect(
      (await checkErrorCodeRegistry(root, 'wiki/Error-Codes.md', new Set())).map((f) => f.cause),
    ).toEqual([
      expect.stringContaining('X_A') as unknown as string,
      expect.stringContaining('X_Z') as unknown as string,
    ]);
  });
});

describe('liveCodes', () => {
  test('reads every code above the reserved heading and none below it', () => {
    const markdown = `\`X_LIVE\`\n\n${RESERVED_HEADING}\n\n\`X_RESERVED\`\n`;
    expect([...liveCodes(markdown)]).toEqual(['X_LIVE']);
    expect([...documentedCodes(markdown)]).toEqual(['X_LIVE', 'X_RESERVED']);
  });

  // A page with no reserved section is all live — the absent heading must not silently exempt it.
  test('treats a page without the heading as entirely live', () => {
    expect([...liveCodes('`X_ONE` `X_TWO`')]).toEqual(['X_ONE', 'X_TWO']);
  });

  // The section that fails on a page is the one nothing reads. A substring match cuts the document
  // at the first *mention* of the heading — and this contract quotes its own heading, in
  // `unregisteredFinding`'s fix and in the row on the page that repeats it — so every live code
  // below that mention silently stopped being checked while the step still reported green.
  test('a heading quoted in prose does not cut the page short', () => {
    const markdown = [
      `move a row under \`${RESERVED_HEADING}\` when nothing throws it yet`,
      '',
      '| `X_LIVE` | means | cause | fix |',
      '',
      RESERVED_HEADING,
      '',
      '| `X_RESERVED` | means | cause | fix |',
    ].join('\n');
    expect([...liveCodes(markdown)]).toEqual(['X_LIVE']);
  });

  // Markdown allows the trailing space an editor leaves behind; the heading is still the heading.
  test('matches the heading line whatever whitespace surrounds it', () => {
    expect([...liveCodes(`\`X_LIVE\`\n  ${RESERVED_HEADING}  \n\`X_RESERVED\``)]).toEqual([
      'X_LIVE',
    ]);
  });
});

describe('this repo', () => {
  const root = join(import.meta.dir, '..', '..', '..');

  // The measurement the rule shipped on: every `code:` in the framework's own source is a literal
  // or a name its own file declares, so `X_ERROR_CODE_UNRESOLVED` enforces outright with no pin
  // table. A pin table nobody can shrink is the shape this repo spends majors deleting.
  test('every code declared here is one the scan can read', async () => {
    expect(await checkErrorCodeResolution(root)).toEqual([]);
    // 90s, matching `scripts/lib/run.ts`'s `REPO_SCAN_TIMEOUT_MS` and `error-contract.test.ts`'s
    // own walk of the same tree: the number is duplicated because a package may not import from
    // the repo that ships it.
  }, 90_000);
});
