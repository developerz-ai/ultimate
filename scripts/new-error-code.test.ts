// The generator, proved on a throwaway root holding copies of real `errors.ts` files and of the
// real `wiki/Error-Codes.md` — never the committed page. Every refusal leaves BOTH files as found,
// because a registration without its row is the gap this exists to close.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no mkdtemp/rm of its own; a unique directory per run keeps test workers apart.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
// why: Bun has no tmpdir() of its own; node:os is the only way to find the platform temp root.
import { tmpdir } from 'node:os';
import { PACKAGE_SECTIONS, registerIn, rowIn } from './lib/error-code-plan';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

// Reads the real tree or spawns real processes, so it runs on the repo-scan backstop.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

import { ScriptError } from './lib/script-error';
import { newErrorCode, WIKI_PAGE } from './new-error-code';

const ROOT = repoRoot();
const made: string[] = [];
afterAll(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

/** A root with the real money and seo registrations, a query one in no known shape, and the page. */
async function fixtureRoot(): Promise<string> {
  const dir = await mkdtemp(`${tmpdir()}/new-error-code-`);
  made.push(dir);
  for (const pkg of ['money', 'seo']) {
    await mkdir(`${dir}/packages/${pkg}/src`, { recursive: true });
    await Bun.write(
      `${dir}/packages/${pkg}/src/errors.ts`,
      Bun.file(`${ROOT}/packages/${pkg}/src/errors.ts`),
    );
  }
  await mkdir(`${dir}/packages/odd/src`, { recursive: true });
  await Bun.write(
    `${dir}/packages/odd/src/errors.ts`,
    "export const odd = new Map([['X_ODD', 't']]);\n",
  );
  await mkdir(`${dir}/wiki`, { recursive: true });
  await Bun.write(`${dir}/${WIKI_PAGE}`, Bun.file(`${ROOT}/${WIKI_PAGE}`));
  return dir;
}

const read = (dir: string, path: string): Promise<string> => Bun.file(`${dir}/${path}`).text();
const refusal = async (run: Promise<unknown>): Promise<string> =>
  run.then(
    () => expect.unreachable('the generator wrote where it had to refuse'),
    (error: unknown) => (error instanceof ScriptError ? error.code : `not a ScriptError`),
  );
const transpiles = (source: string): boolean => {
  try {
    new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
    return true;
  } catch {
    return false;
  }
};

describe('a new code, registered and documented in one edit', () => {
  test('money: into the codes array AND the titles table, and a row under its section', async () => {
    const dir = await fixtureRoot();
    const result = await newErrorCode(dir, [
      'X_MONEY_ROUNDING_LOST',
      '--package',
      'money',
      '--title',
      "a conversion that can't keep its minor units",
      '--fix',
      "call convert(amount, rate, { rounding: 'half-even' })",
      '--meaning',
      'a rate with more | decimals than the currency',
    ]);
    expect(result.written).toEqual(['packages/money/src/errors.ts', WIKI_PAGE]);
    const errors = await read(dir, 'packages/money/src/errors.ts');
    expect(errors).toContain("  'X_MONEY_ROUNDING_LOST',\n] as const;");
    expect(errors).toContain(
      "  X_MONEY_ROUNDING_LOST: 'a conversion that can\\'t keep its minor units',\n};",
    );
    expect(transpiles(errors)).toBe(true);

    const wiki = (await read(dir, WIKI_PAGE)).split('\n');
    const row = wiki.findIndex((line) => line.startsWith('| `X_MONEY_ROUNDING_LOST`'));
    const section = wiki.indexOf('## i18n, money, time');
    const next = wiki.findIndex((line, index) => index > section && line.startsWith('## '));
    expect(row).toBeGreaterThan(section);
    expect(row).toBeLessThan(next);
    // In the table, not after it: the line above is a row too.
    expect(wiki[row - 1]).toStartWith('|');
    expect(wiki[row]).toContain('more \\| decimals');
  });

  test('the row goes in the section`s CODE table, not the first table it opens with', async () => {
    // Scraping opens with a retry-override table (`| Set | Codes | Effect |`) before its codes.
    const dir = await fixtureRoot();
    const before = (await read(dir, WIKI_PAGE)).split('\n');
    const heading = before.indexOf('## Scraping');
    const header = before.findIndex((line, index) => index > heading && /^\| Code \|/.test(line));
    let end = header;
    while ((before[end + 1] ?? '').startsWith('|')) end += 1;
    const after = rowIn(before.join('\n'), {
      code: 'X_SCRAPE_PROBE',
      pkg: 'scraping',
      title: 't',
      fix: 'f',
    }).split('\n');
    expect(after[end + 1]).toStartWith('| `X_SCRAPE_PROBE`');
  });

  test('seo: a literal registerErrorCodes({ … }) gets a { title } entry', async () => {
    const dir = await fixtureRoot();
    await newErrorCode(dir, [
      'X_SEO_ALT_MISSING',
      '--package',
      'seo',
      '--title',
      'an image with no alt text',
      '--fix',
      'add alt to the <img> the cause names',
    ]);
    const errors = await read(dir, 'packages/seo/src/errors.ts');
    expect(errors).toContain("  X_SEO_ALT_MISSING: { title: 'an image with no alt text' },\n});");
    expect(transpiles(errors)).toBe(true);
  });
});

describe('every refusal is coded and writes nothing', () => {
  test('an errors.ts in no recognised shape is refused by name', async () => {
    const dir = await fixtureRoot();
    const before = [await read(dir, 'packages/odd/src/errors.ts'), await read(dir, WIKI_PAGE)];
    const code = await refusal(
      newErrorCode(dir, [
        'X_ODD_THING',
        '--package',
        'odd',
        '--title',
        't',
        '--fix',
        'f',
        '--section',
        'Core and runtime',
      ]),
    );
    expect(code).toBe('X_NEW_ERROR_CODE_PATTERN_UNKNOWN');
    expect([await read(dir, 'packages/odd/src/errors.ts'), await read(dir, WIKI_PAGE)]).toEqual(
      before,
    );
  });

  test('a code already registered, or already on the page, is refused', async () => {
    const dir = await fixtureRoot();
    const argv = (code: string) => [code, '--package', 'money', '--title', 't', '--fix', 'f'];
    expect(await refusal(newErrorCode(dir, argv('X_CURRENCY_UNKNOWN')))).toBe(
      'X_NEW_ERROR_CODE_EXISTS',
    );
    expect(await refusal(newErrorCode(dir, argv('X_ABORTED')))).toBe('X_NEW_ERROR_CODE_EXISTS');
    // …and the refusal on the PAGE left the package file alone, though it was planned first.
    expect(await read(dir, 'packages/money/src/errors.ts')).not.toContain("'X_ABORTED'");
  });

  test('a malformed code, a missing flag, an unknown package or section is refused', async () => {
    const dir = await fixtureRoot();
    const ok = ['--package', 'money', '--title', 't', '--fix', 'f'];
    expect(await refusal(newErrorCode(dir, ['x_lower', ...ok]))).toBe('X_NEW_ERROR_CODE_INVALID');
    expect(await refusal(newErrorCode(dir, ['X_A_B', '--package', 'money']))).toBe(
      'X_NEW_ERROR_CODE_INVALID',
    );
    expect(
      await refusal(
        newErrorCode(dir, ['X_A_B', '--package', 'nope', '--title', 't', '--fix', 'f']),
      ),
    ).toBe('X_NEW_ERROR_CODE_INVALID');
    expect(await refusal(newErrorCode(dir, ['X_A_B', ...ok, '--section', 'No such section']))).toBe(
      'X_NEW_ERROR_CODE_INVALID',
    );
  });
});

describe('the real tree', () => {
  test('every default section is a heading the real page carries', async () => {
    const page = await Bun.file(`${ROOT}/${WIKI_PAGE}`).text();
    for (const section of new Set(PACKAGE_SECTIONS.values())) {
      expect(page.split('\n')).toContain(`## ${section}`);
    }
  });

  test('most real packages are in a shape it can add to — the rest are refused, never guessed', async () => {
    const shapes: Record<string, string> = {};
    for (const pkg of PACKAGE_SECTIONS.keys()) {
      const file = Bun.file(`${ROOT}/packages/${pkg}/src/errors.ts`);
      if (!(await file.exists())) continue;
      try {
        const out = registerIn(await file.text(), pkg, {
          code: 'X_PROBE_ONLY',
          pkg,
          title: 't',
          fix: 'f',
        });
        // Accepted means VALID: a plan that corrupts the file is worse than a refusal.
        shapes[pkg] = transpiles(out) ? 'ok' : 'crash';
      } catch (error) {
        shapes[pkg] = error instanceof ScriptError ? error.code : 'crash';
      }
    }
    expect(Object.values(shapes)).not.toContain('crash');
    expect(Object.values(shapes).filter((shape) => shape === 'ok').length).toBeGreaterThan(20);
    expect(shapes['money']).toBe('ok');
    expect(shapes['seo']).toBe('ok');
    // A titles table beside a BORROWED codes array: the borrowed list is not where a new code goes.
    expect(shapes['query']).toBe('ok');
  });
});
