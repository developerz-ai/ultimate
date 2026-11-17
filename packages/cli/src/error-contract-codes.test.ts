// The CODE half of `error-contract.ts`: which codes a repo declares, whether each one is readable,
// and what the reference page owes them. `error-contract.test.ts` reached the 500-line ceiling
// again — the same split `error-contract-paths.test.ts` already made, along the other seam: that
// file keeps "is this fix an instruction", this one keeps "which codes exist, and can we read them".
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import {
  checkErrorCodeDocs,
  checkErrorCodeDocsIn,
  checkErrorCodeRegistry,
  checkErrorCodeRegistryIn,
  checkErrorCodeResolution,
  collectDeclaredCodes,
  documentedCodes,
  documentedCodesIn,
  type ErrorCodePage,
  liveCodes,
  liveCodesIn,
  RESERVED_HEADING,
} from './error-contract';

// The reference is a page SET: an index (`## Reserved codes` lives there) and one page per owner.
const INDEX = 'wiki/Error-Codes.md';
const DB_PAGE = 'wiki/Error-Codes-db.md';
const HTTP_PAGE = 'wiki/Error-Codes-http.md';
const pagesOf = (index: string, db: string, http: string): readonly ErrorCodePage[] => [
  { path: INDEX, text: index },
  { path: DB_PAGE, text: db },
  { path: HTTP_PAGE, text: http },
];

describe('documentedCodesIn', () => {
  test('reads every code the page set names, including a shared row', () => {
    const pages = pagesOf(
      '# Error codes\n',
      '| `X_A` | means | cause | fix |\n| `X_B` / `X_C` | means | cause | fix |\n',
      '| `X_D` | means | cause | fix |\n',
    );
    expect([...documentedCodesIn(pages).keys()].sort()).toEqual(['X_A', 'X_B', 'X_C', 'X_D']);
  });

  test('maps each code to the page that names it, the first by path when two do', () => {
    const pages = pagesOf('`X_R`\n', '| `X_SHARED` | db |\n', '| `X_SHARED` | http |\n');
    const documented = documentedCodesIn([...pages].reverse());
    expect(documented.get('X_SHARED')).toBe(DB_PAGE);
    expect(documented.get('X_R')).toBe(INDEX);
  });

  // The index's generated "every code" table names each code PLAIN, so the index alone documents
  // nothing — a code is documented by its row on an owner page, or by the reserved block.
  test('a plain code in the index table documents nothing', () => {
    const pages = pagesOf('| Code | Means | Page |\n|---|---|---|\n| X_A | means | db |\n', '', '');
    expect(documentedCodesIn(pages).has('X_A')).toBe(false);
  });
});

describe('the code checks, over a repo', () => {
  let root = '';

  const write = async (path: string, text: string): Promise<void> => {
    // `Bun.write` creates the intermediate directories, so it is this repo's `mkdir -p` too.
    await Bun.write(join(root, path), text);
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

  test('checkErrorCodeDocsIn demands a row for a const-declared code too', async () => {
    await write(
      'scripts/graph.ts',
      "const STALE = 'X_DOC_STALE';\nthrow new E({ code: STALE, fix: 'bun run manifest' });\n",
    );
    const [finding, ...rest] = await checkErrorCodeDocsIn(root, pagesOf('no codes here\n', '', ''));
    expect(rest).toEqual([]);
    expect(finding?.cause).toContain('X_DOC_STALE is declared at scripts/graph.ts:2');
    expect(finding?.fix).toContain('wiki/Error-Codes-scripts.md');
  });

  // The row is owed on the code's OWNER page — the page `framework.manifest.json` files it under —
  // so the fix names that file, not the index an agent would otherwise append to.
  test('checkErrorCodeDocsIn reports a declared code no page names, at its owner page', async () => {
    await write(
      'packages/db/src/errors.ts',
      "export const DB_ERROR_CODES = ['X_A', 'X_B'] as const;\n",
    );
    const pages = pagesOf('# Error codes\n', '| `X_A` | means | cause | fix |\n', '');
    const [finding, ...rest] = await checkErrorCodeDocsIn(root, pages);
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_ERROR_CODE_UNDOCUMENTED');
    expect(finding?.cause).toContain('X_B is declared at packages/db/src/errors.ts:1');
    expect(finding?.fix).toBe(
      'x errors explain X_B --json   # its title and fix: add a row for X_B to wiki/Error-Codes-db.md, with its cause and the command that fixes it',
    );
    expect(finding?.at).toBe(DB_PAGE);
  });

  // The union is the point: a code is documented by ANY page in the set — db's code on db's page,
  // http's on http's, a reserved one on the index — and none of them alone covers the repo.
  test('checkErrorCodeDocsIn passes when every declared code is on some page of the set', async () => {
    await write('packages/db/src/errors.ts', "export const DB_ERROR_CODES = ['X_A'] as const;\n");
    await write(
      'packages/http/src/errors.ts',
      "export const HTTP_ERROR_CODES = ['X_H'] as const;\n",
    );
    await write(
      'packages/core/src/errors.ts',
      "export const CORE_ERROR_CODES = ['X_R'] as const;\n",
    );
    const pages = pagesOf(
      `${RESERVED_HEADING}\n\n| \`X_R\` | reserved |\n`,
      '| `X_A` | means | cause | fix |\n',
      '| `X_H` | means | cause | fix |\n',
    );
    expect(await checkErrorCodeDocsIn(root, pages)).toEqual([]);
    expect(await checkErrorCodeDocsIn(root, pages.slice(0, 2))).toHaveLength(1);
  });

  // A missing reference must fail loudly: silently passing would make an empty repo the
  // best-scoring one, which is the shape of every gate that reads green over nothing.
  test('checkErrorCodeDocsIn fails when the reference has no page at all', async () => {
    await write('packages/db/src/errors.ts', "export const DB_ERROR_CODES = ['X_A'] as const;\n");
    const [finding, ...rest] = await checkErrorCodeDocsIn(root, []);
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_ERROR_CODE_UNDOCUMENTED');
    expect(finding?.cause).toContain('no page');
    expect(finding?.fix).toContain('wiki/Error-Codes.md');
  });

  test('one finding per code, however many files declare it', async () => {
    await write('packages/db/src/errors.ts', "export const DB_ERROR_CODES = ['X_A'] as const;\n");
    await write('packages/db/src/thing.ts', "throw new E({ code: 'X_A', fix: 'x help' });\n");
    expect(await checkErrorCodeDocsIn(root, pagesOf('no codes here\n', '', ''))).toHaveLength(1);
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
  test('checkErrorCodeRegistryIn reports a live row no package registers, at its page', () => {
    const pages = pagesOf(
      '# Error codes\n',
      '| `X_A` | means | cause | fix |\n',
      '| `X_GHOST` | means | cause | fix |\n',
    );
    const [finding, ...rest] = checkErrorCodeRegistryIn(pages, new Set(['X_A']));
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_ERROR_CODE_UNREGISTERED');
    expect(finding?.cause).toContain('X_GHOST');
    expect(finding?.cause).toContain(HTTP_PAGE);
    expect(finding?.fix).toContain('src/errors.ts');
    expect(finding?.fix).toContain(RESERVED_HEADING);
    expect(finding?.fix).toContain(INDEX);
    expect(finding?.at).toBe(HTTP_PAGE);
  });

  // The whole point of the partition: a reserved name is documented on purpose, and a rule that
  // demanded a registration for it would delete the row instead of the ambiguity.
  test('checkErrorCodeRegistryIn exempts everything below the index reserved heading', () => {
    const pages = pagesOf(
      `intro \`X_A\`\n\n${RESERVED_HEADING}\n\n| \`X_GHOST\` | x |\n`,
      '| `X_A` | means | cause | fix |\n',
      '',
    );
    expect(checkErrorCodeRegistryIn(pages, new Set(['X_A']))).toEqual([]);
  });

  // `checkErrorCodeDocsIn` already reports the empty reference, with the fix for creating it. A
  // second finding for the same absence would double every count and name no new work.
  test('checkErrorCodeRegistryIn leaves the missing-reference finding to the docs half', () => {
    expect(checkErrorCodeRegistryIn([], new Set())).toEqual([]);
  });

  test('checkErrorCodeRegistryIn reports each ghost once, sorted, across pages', () => {
    const pages = pagesOf('', '`X_Z` `X_A` `X_Z`\n', '`X_Z`\n');
    expect(checkErrorCodeRegistryIn(pages, new Set()).map((f) => f.cause)).toEqual([
      expect.stringContaining('X_A') as unknown as string,
      expect.stringContaining('X_Z') as unknown as string,
    ]);
  });
});

const one = (text: string): readonly ErrorCodePage[] => [{ path: INDEX, text }];

describe('liveCodesIn', () => {
  test('reads every code above the reserved heading and none below it', () => {
    const markdown = `\`X_LIVE\`\n\n${RESERVED_HEADING}\n\n\`X_RESERVED\`\n`;
    expect([...liveCodesIn(one(markdown)).keys()]).toEqual(['X_LIVE']);
    expect([...documentedCodesIn(one(markdown)).keys()]).toEqual(['X_LIVE', 'X_RESERVED']);
  });

  // The reserved block is the index's; an owner page has none, so it is live from top to bottom —
  // and the index's cut must not leak onto the pages after it.
  test('every owner page is live whole, beside an index with a reserved block', () => {
    const pages = pagesOf(`${RESERVED_HEADING}\n\`X_RESERVED\`\n`, '`X_DB`\n', '`X_HTTP`\n');
    expect([...liveCodesIn(pages).keys()].sort()).toEqual(['X_DB', 'X_HTTP']);
  });

  // A page with no reserved section is all live — the absent heading must not silently exempt it.
  test('treats a page without the heading as entirely live', () => {
    expect([...liveCodesIn(one('`X_ONE` `X_TWO`')).keys()]).toEqual(['X_ONE', 'X_TWO']);
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
    expect([...liveCodesIn(one(markdown)).keys()]).toEqual(['X_LIVE']);
  });

  // Markdown allows the trailing space an editor leaves behind; the heading is still the heading.
  test('matches the heading line whatever whitespace surrounds it', () => {
    const markdown = `\`X_LIVE\`\n  ${RESERVED_HEADING}  \n\`X_RESERVED\``;
    expect([...liveCodesIn(one(markdown)).keys()]).toEqual(['X_LIVE']);
  });
});

// The deprecated single-page names, kept for a minor: each still answers the way it did, one page.
describe('the deprecated single-page names', () => {
  test('documentedCodes and liveCodes read one markdown string into a Set', () => {
    const markdown = `\`X_LIVE\`\n${RESERVED_HEADING}\n\`X_RESERVED\`\n`;
    expect(documentedCodes(markdown)).toEqual(new Set(['X_LIVE', 'X_RESERVED']));
    expect(liveCodes(markdown)).toEqual(new Set(['X_LIVE']));
  });

  describe('over a repo', () => {
    let root = '';
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'error-codes-legacy-'));
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    test('checkErrorCodeDocs reads its one page and owes the row to that page', async () => {
      const db = "export const DB_ERROR_CODES = ['X_A', 'X_B'] as const;\n";
      await Bun.write(join(root, 'packages/db/src/errors.ts'), db);
      expect((await checkErrorCodeDocs(root, INDEX))[0]?.cause).toContain('does not exist');
      await Bun.write(join(root, INDEX), '| `X_A` | means | cause | fix |\n');
      const [finding, ...rest] = await checkErrorCodeDocs(root, INDEX);
      expect(rest).toEqual([]);
      expect(finding?.fix).toBe(
        'x errors explain X_B --json   # its title and fix: add a row for X_B to wiki/Error-Codes.md, with its cause and the command that fixes it',
      );
    });

    test('checkErrorCodeRegistry stays async over its one page, silent when it is absent', async () => {
      // Any page name the host chose, as before: that one page is its own index.
      const own = 'docs/errors.md';
      expect(await checkErrorCodeRegistry(root, own, new Set())).toEqual([]);
      await Bun.write(join(root, own), '| `X_GHOST` | means | cause | fix |\n');
      const [finding] = await checkErrorCodeRegistry(root, own, new Set());
      expect(finding?.at).toBe(own);
      expect(finding?.fix).toContain(`"${RESERVED_HEADING}" in ${own}`);
    });
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
