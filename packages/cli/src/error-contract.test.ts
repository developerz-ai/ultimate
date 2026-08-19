import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BANNED_PHRASES,
  checkErrorCodeDocs,
  checkErrorCodeRegistry,
  checkErrorFixes,
  collectDeclaredCodes,
  documentedCodes,
  fixProblem,
  liveCodes,
  RESERVED_HEADING,
  staticFix,
} from './error-contract';

describe('staticFix', () => {
  // Without this, `check egress to ${new URL(url).host}` reads as a call expression and pure
  // advice launders itself into an instruction.
  test('blanks interpolations so they cannot supply a command token', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — a literal ${…} is the case under test
    expect(staticFix('check egress to ${new URL(url).host}')).toBe('check egress to <value>');
  });
});

describe('fixProblem', () => {
  test('accepts a runnable command', () => {
    expect(fixProblem('x db gen "add publish_at"')).toBeUndefined();
    expect(fixProblem('bunx biome check --write .')).toBeUndefined();
  });

  test('accepts advice that also names the command to run', () => {
    expect(
      fixProblem('check the gateway, then: x actions describe publish --json'),
    ).toBeUndefined();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — a literal ${…} is the case under test
    expect(fixProblem('add ${keys} to .env (copy .env.example), then run: x env check')).toBe(
      undefined,
    );
  });

  test('accepts an edit instruction naming a call or a file', () => {
    expect(fixProblem("set jobs.driver = 'pg' in app.config.ts")).toBeUndefined();
    expect(fixProblem('add description to meta in site/pricing/page.tsx')).toBeUndefined();
    expect(fixProblem('runWithContext(createContext({ … }), fn)')).toBeUndefined();
  });

  test('accepts an instruction with no banned phrase and no command', () => {
    expect(fixProblem('move this call inside a handler')).toBeUndefined();
  });

  test('rejects an empty or whitespace-only fix', () => {
    expect(fixProblem('')).toBe('the fix line is empty');
    expect(fixProblem('   ')).toBe('the fix line is empty');
  });

  test('rejects every banned phrase when nothing runnable is named', () => {
    for (const advice of [
      'check your database connection',
      'make sure the row exists',
      'try again later',
      'see the docs',
    ]) {
      expect(fixProblem(advice)).toContain('names no command, call or file');
    }
  });

  test('the article is not what makes it advice — "see docs" is the same shrug', () => {
    // `packages/mcp/src/server.ts` shipped exactly `see docs` as a `fix:` and passed the gate:
    // the pattern was `see the docs?`, one article longer than the line that got through. The
    // whole family goes, because the next one is as likely to be `read the docs` as `see docs`.
    for (const advice of [
      'see docs',
      'read the docs',
      'consult the documentation',
      'refer to the docs for the field list',
      'see documentation',
    ]) {
      expect(fixProblem(advice)).toContain('names no command, call or file');
    }
  });

  test('and it still yields to a real instruction, which is the whole conditional rule', () => {
    // Naming the observation AND the command is the shape the contract wants — a rule that
    // refused this would push an author into deleting the sentence that says where to look.
    expect(
      fixProblem('see the docs for the field list, then: x actions describe posts.publish'),
    ).toBeUndefined();
  });

  test('names the phrase it refused, so the rewrite is obvious', () => {
    expect(fixProblem('check your database connection')).toContain('"check"');
  });

  // Word boundaries: `checksum` is not `check`, and `x env check` is a command, not advice.
  test('does not fire on a word that merely contains a banned phrase', () => {
    expect(fixProblem('recompute the checksum over the exact bytes you send')).toBeUndefined();
  });

  test('an interpolated host cannot rescue advice', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is source text — a literal ${…} is the case under test
    expect(fixProblem('check egress to ${new URL(url).host} from this host')).toContain(
      'names no command',
    );
  });

  test('the banned list is the one the contract documents', () => {
    expect(BANNED_PHRASES).toHaveLength(4);
  });
});

describe('documentedCodes', () => {
  test('reads every code the page names, including a shared row', () => {
    const page = '| `X_A` | means | cause | fix |\n| `X_B` / `X_C` | means | cause | fix |\n';
    expect([...documentedCodes(page)].sort()).toEqual(['X_A', 'X_B', 'X_C']);
  });
});

describe('the checks, over a repo', () => {
  let root = '';

  const write = async (path: string, text: string): Promise<void> => {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'error-contract-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('checkErrorFixes reports the file, the line and the rewrite', async () => {
    await write('packages/db/src/thing.ts', "throw new E({\n  fix: 'check the connection',\n});\n");
    const [finding, ...rest] = await checkErrorFixes(root);
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_ERROR_FIX_INVALID');
    expect(finding?.at).toBe('packages/db/src/thing.ts:2');
    expect(finding?.fix).toContain('rewrite the fix at packages/db/src/thing.ts:2');
  });

  test('checkErrorFixes passes a repo whose fixes are all runnable', async () => {
    // `x db migrate`, not the `x db status` this used to assert: the fixture's own fix cited a
    // subcommand the CLI does not ship, which is precisely the condition the check now catches.
    await write('packages/db/src/thing.ts', "throw new E({ fix: 'x db migrate --json' });\n");
    expect(await checkErrorFixes(root)).toEqual([]);
  });

  test('a fix citing a command this build does not ship is a finding', async () => {
    // The failure that shipped six times: the text rule sees a command and passes, and the reader
    // gets X_CLI_UNKNOWN_COMMAND instead of the fix. Resolving it against the registry is the
    // only thing that can tell the two apart.
    await write('packages/db/src/thing.ts', "throw new E({ fix: 'x db status --json' });\n");
    const [finding] = await checkErrorFixes(root);
    expect(finding?.code).toBe('X_ERROR_FIX_INVALID');
    expect(finding?.cause).toContain('x db status');
  });

  test('a fix that names no command at all is still runnable', async () => {
    // Axiom 4 asks for an executable instruction, not for a CLI invocation. A universal rule here
    // would push an author into citing a command that does not really fix it.
    await write(
      'packages/db/src/thing.ts',
      "throw new E({ fix: 'set OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318' });\n",
    );
    expect(await checkErrorFixes(root)).toEqual([]);
  });

  // The hole that shipped four bad fix lines in `packages/ui/src/icons/build-icons.ts`: the
  // helper is declared in a SIBLING module, so the same-file rule read the call site's argument as
  // nobody's fix and the gate checked nothing. A per-package `errors.ts` full of factories is the
  // house pattern, so this is the shape most fixes arrive in.
  test('a fix handed to a factory in a sibling module is read', async () => {
    await write(
      'packages/ui/src/errors.ts',
      'export function invalidIconDataError(found: string, fix: string) {\n' +
        "  return new UiError({ code: 'X_UI_INVALID_VALUE', cause: found, fix });\n" +
        '}\n',
    );
    await write(
      'packages/ui/src/icons/build-icons.ts',
      "import { invalidIconDataError } from '../errors';\n" +
        "throw invalidIconDataError('bad', 'check the network, then re-run the generator');\n",
    );
    const [finding, ...rest] = await checkErrorFixes(root);
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_ERROR_FIX_INVALID');
    expect(finding?.at).toBe('packages/ui/src/icons/build-icons.ts:2');
  });

  // The other rule the same seam owes: a citation resolved against the registry, not just the
  // text rule. `x ui icons` names a command, which is exactly why the text rule passes it.
  test('a cross-file fix citing a command this build does not ship is a finding', async () => {
    await write(
      'packages/ui/src/errors.ts',
      "const raise = (cause: string, fix: string) => new E({ code: 'X_A', cause, fix });\n" +
        'export { raise };\n',
    );
    await write(
      'packages/ui/src/icons/build-icons.ts',
      "import { raise } from '../errors';\nraise('bad', 'x ui icons --json');\n",
    );
    const [finding] = await checkErrorFixes(root);
    expect(finding?.cause).toContain('x ui');
  });

  // `@ultimat3/render`'s `errors.ts` declares fourteen classes taking `(cause, fix)` positionally
  // and calls them from its own modules. Measured: zero SAME-file call sites, so the same-file
  // rule was dead code for the entire form and 15 codes never had a fix line read.
  test('a fix handed to an error class in a sibling module is read', async () => {
    await write(
      'packages/render/src/errors.ts',
      'export class RouteModeInvalidError extends UltimateError {\n' +
        "  static readonly code = 'X_ROUTE_MODE_INVALID' as const;\n" +
        '  constructor(cause: string, fix: string) {\n' +
        '    super({ code: RouteModeInvalidError.code, cause, fix });\n' +
        '  }\n' +
        '}\n',
    );
    await write(
      'packages/render/src/modes.ts',
      "import { RouteModeInvalidError } from './errors';\n" +
        "throw new RouteModeInvalidError('static may not read the request', 'try another mode');\n",
    );
    const [finding, ...rest] = await checkErrorFixes(root);
    expect(rest).toEqual([]);
    expect(finding?.at).toBe('packages/render/src/modes.ts:2');
  });

  // The importer names the symbol; the declaration names the position. An alias is the one place
  // those two disagree, and reading the declaration's name at the call site would resolve nothing.
  test('an aliased import is resolved under the name the caller uses', async () => {
    await write(
      'packages/db/src/errors.ts',
      "export function dbNotImplemented(cause: string, fix: string) { throw new E({ code: 'X_A', cause, fix }); }\n",
    );
    await write(
      'packages/db/src/pglite-branch.ts',
      "import { dbNotImplemented as unsupported } from './errors';\n" +
        "unsupported('pglite has no branches', 'see the docs');\n",
    );
    const [finding] = await checkErrorFixes(root);
    expect(finding?.at).toBe('packages/db/src/pglite-branch.ts:2');
  });

  test('a runnable cross-file fix is not a finding', async () => {
    await write(
      'packages/db/src/errors.ts',
      "export function dbNotImplemented(cause: string, fix: string) { throw new E({ code: 'X_A', cause, fix }); }\n",
    );
    await write(
      'packages/db/src/pglite-branch.ts',
      "import { dbNotImplemented } from './errors';\n" +
        "dbNotImplemented('pglite has no branches', 'x db branch ls --json');\n",
    );
    expect(await checkErrorFixes(root)).toEqual([]);
  });

  // A test fixture asserting on a bad fix is a test, not a shipped error.
  test('checkErrorFixes skips tests and generated declarations', async () => {
    await write('packages/db/src/thing.test.ts', "expect(e.fix).toBe('check the connection');\n");
    await write('packages/db/src/thing.d.ts', "declare const fix: 'check the connection';\n");
    expect(await checkErrorFixes(root)).toEqual([]);
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

  // The other half — every shipped code has a row in wiki/Error-Codes.md — is asserted once, in
  // `scripts/verify.test.ts` through `errorCodeDocs(root)`: the page is the host repo's to name.
  // Walks every shipped source file in the monorepo. Bun's 5s default covered that while the
  // suite ran serially and stopped the moment `x test` began sharding across workers, because the
  // shards compete for the same cores — and WHICH shard this lands in depends on the file count,
  // so it presents as an intermittent failure rather than a slow test. The scan is the point of
  // the test, so the timeout is what moves. Same shape as `scripts/verify.test.ts`.
  test('every shipped fix line is runnable', async () => {
    expect(await checkErrorFixes(root)).toEqual([]);
    // 90s, matching `scripts/lib/run.ts`'s `REPO_SCAN_TIMEOUT_MS`. The number is duplicated rather
    // than imported because `packages/cli` cannot reach `scripts/` — a package may not depend on
    // the repo that ships it. Raise both together; ~5s alone, ~30s under eight competing workers.
  }, 90_000);
});
