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
    await write('packages/db/src/thing.ts', "throw new E({ fix: 'x db status --json' });\n");
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
    await write('packages/db/src/errors.ts', "export const CODES = ['X_B'] as const;\n");
    await write('packages/db/src/pool.ts', "throw new E({ code: 'X_C', fix: 'x db status' });\n");
    await write('scripts/gate.ts', "throw new E({ code: 'X_A', fix: 'bun run gate' });\n");
    expect(await collectDeclaredCodes(root)).toEqual([
      { code: 'X_A', at: 'scripts/gate.ts', line: 1 },
      { code: 'X_B', at: 'packages/db/src/errors.ts', line: 1 },
      { code: 'X_C', at: 'packages/db/src/pool.ts', line: 1 },
    ]);
  });

  test('collectDeclaredCodes skips tests and generated declarations', async () => {
    await write('packages/db/src/errors.ts', "export const CODES = ['X_A'] as const;\n");
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
    await write('packages/db/src/errors.ts', "\nexport const CODES = ['X_A'] as const;\n");
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
    await write('packages/core/src/error-codes.ts', "const T = {\n  X_A: 'not implemented',\n};\n");
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
    await write('packages/db/src/errors.ts', "export const CODES = ['X_A', 'X_B'] as const;\n");
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
    await write('packages/db/src/errors.ts', "export const CODES = ['X_A'] as const;\n");
    await write('wiki/Error-Codes.md', '| `X_A` | means | cause | fix |\n');
    expect(await checkErrorCodeDocs(root, 'wiki/Error-Codes.md')).toEqual([]);
  });

  // A missing reference page must fail loudly: silently passing would make an empty repo the
  // best-scoring one, which is the shape of every gate that reads green over nothing.
  test('checkErrorCodeDocs fails when the reference page is absent', async () => {
    await write('packages/db/src/errors.ts', "export const CODES = ['X_A'] as const;\n");
    const [finding] = await checkErrorCodeDocs(root, 'wiki/Error-Codes.md');
    expect(finding?.code).toBe('X_ERROR_CODE_UNDOCUMENTED');
    expect(finding?.cause).toContain('does not exist');
  });

  test('one finding per code, however many files declare it', async () => {
    await write('packages/db/src/errors.ts', "export const CODES = ['X_A'] as const;\n");
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
  test('every shipped fix line is runnable', async () => {
    expect(await checkErrorFixes(root)).toEqual([]);
  });
});
