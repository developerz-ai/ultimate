import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BANNED_PHRASES,
  checkErrorCodeDocs,
  checkErrorFixes,
  documentedCodes,
  fixProblem,
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
});

describe('this repo', () => {
  const root = join(import.meta.dir, '..', '..', '..');

  // The other half — every shipped code has a row in wiki/Error-Codes.md — is asserted once, in
  // `scripts/verify.test.ts` through `errorCodeDocs(root)`: the page is the host repo's to name.
  test('every shipped fix line is runnable', async () => {
    expect(await checkErrorFixes(root)).toEqual([]);
  });
});
