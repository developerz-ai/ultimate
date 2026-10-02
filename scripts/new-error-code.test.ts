// The generator, proved on a throwaway root holding copies of real `errors.ts` files and of the
// real `wiki/Error-Codes.md` — never the committed page. Every refusal leaves BOTH files as found,
// because a registration without its row is the gap this exists to close.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no mkdtemp/rm of its own; a unique directory per run keeps test workers apart.
import { mkdir } from 'node:fs/promises';
import { PACKAGE_SECTIONS, registerIn, rowIn } from './lib/error-code-plan';
import { REPO_SCAN_TIMEOUT_MS } from './lib/run';

// Reads the real tree or spawns real processes, so it runs on the repo-scan backstop.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);
afterAll(removeFixtureRoots);

import { ScriptError } from './lib/script-error';
import { newErrorCode, STATUS_BACKLOG, STATUS_TABLE, WIKI_PAGE } from './new-error-code';
import {
  fixtureRoot,
  ROOT,
  read,
  refusal,
  removeFixtureRoots,
  transpiles,
} from './new-error-code.fixtures';

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
      '--cause',
      'a rate with more | decimals than the currency',
      '--status',
      '422',
    ]);
    expect(result.written).toEqual(['packages/money/src/errors.ts', WIKI_PAGE, STATUS_TABLE]);
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
      cause: 'c',
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
      '--cause',
      'what usually makes it happen',
      '--fix',
      'add alt to the <img> the cause names',
      '--off-socket',
    ]);
    const errors = await read(dir, 'packages/seo/src/errors.ts');
    expect(errors).toContain("  X_SEO_ALT_MISSING: { title: 'an image with no alt text' },\n});");
    expect(transpiles(errors)).toBe(true);
  });
});

describe('a package whose titles are not in the first file the planner looks at', () => {
  // `@ultimat3/core` keeps its REGISTRY in `error-codes.ts` and its titles in
  // `core-error-codes.ts`, closed by `} as const;`. The planner stopped at the registry and
  // refused the package every other package depends on (plan 101, slice 01).
  test('core: the title lands in core-error-codes.ts, inside the literal', async () => {
    const dir = await fixtureRoot();
    await mkdir(`${dir}/packages/core/src`, { recursive: true });
    for (const file of ['error-codes.ts', 'core-error-codes.ts', 'errors.ts']) {
      await Bun.write(
        `${dir}/packages/core/src/${file}`,
        Bun.file(`${ROOT}/packages/core/src/${file}`),
      );
    }
    const registry = await read(dir, 'packages/core/src/error-codes.ts');
    const result = await newErrorCode(dir, [
      'X_CORE_PROBE_ONLY',
      '--package',
      'core',
      '--title',
      'a probe',
      '--cause',
      'what usually makes it happen',
      '--fix',
      'x doctor --json',
      '--off-socket',
    ]);
    expect(result.written).toEqual([
      'packages/core/src/core-error-codes.ts',
      WIKI_PAGE,
      STATUS_BACKLOG,
    ]);
    const titles = await read(dir, 'packages/core/src/core-error-codes.ts');
    expect(titles).toContain("  X_CORE_PROBE_ONLY: 'a probe',\n} as const;");
    expect(transpiles(titles)).toBe(true);
    // The registry it could not add to is left exactly as found.
    expect(await read(dir, 'packages/core/src/error-codes.ts')).toBe(registry);
    expect(await read(dir, WIKI_PAGE)).toContain('| `X_CORE_PROBE_ONLY` | a probe |');
  });

  // `@ultimat3/entity` keeps its registry in `entity-error.ts` — split from `errors.ts` so a
  // browser module can raise a code without importing `@ultimat3/db` (plan 101, slice 03).
  test('entity: the code joins the owned array and the titles in entity-error.ts', async () => {
    const dir = await fixtureRoot();
    await mkdir(`${dir}/packages/entity/src`, { recursive: true });
    for (const file of ['entity-error.ts', 'errors.ts']) {
      await Bun.write(
        `${dir}/packages/entity/src/${file}`,
        Bun.file(`${ROOT}/packages/entity/src/${file}`),
      );
    }
    const result = await newErrorCode(dir, [
      'X_ENTITY_PROBE_ONLY',
      '--package',
      'entity',
      '--title',
      'a probe',
      '--cause',
      'what usually makes it happen',
      '--fix',
      'x doctor --json',
      '--status',
      '500',
    ]);
    expect(result.written).toEqual([
      'packages/entity/src/entity-error.ts',
      WIKI_PAGE,
      STATUS_TABLE,
    ]);
    const errors = await read(dir, 'packages/entity/src/entity-error.ts');
    expect(errors).toContain("  'X_ENTITY_PROBE_ONLY',\n] as const;");
    expect(errors).toContain("  X_ENTITY_PROBE_ONLY: 'a probe',\n};");
    expect(transpiles(errors)).toBe(true);
  });

  test('a code any candidate file already names is refused, not added to the next one', async () => {
    const dir = await fixtureRoot();
    await mkdir(`${dir}/packages/core/src`, { recursive: true });
    await Bun.write(
      `${dir}/packages/core/src/error-codes.ts`,
      "export const registry = new Map([['X_CORE_TAKEN', 't']]);\n",
    );
    await Bun.write(
      `${dir}/packages/core/src/core-error-codes.ts`,
      "const CORE_CODE_TITLES = {\n  X_A: 'a',\n} as const;\n",
    );
    const argv = [
      'X_CORE_TAKEN',
      '--package',
      'core',
      '--title',
      't',
      '--cause',
      'what usually makes it happen',
      '--fix',
      'f',
      '--off-socket',
    ];
    expect(await refusal(newErrorCode(dir, argv))).toBe('X_NEW_ERROR_CODE_EXISTS');
    expect(await read(dir, 'packages/core/src/core-error-codes.ts')).not.toContain('X_CORE_TAKEN');
  });
});

describe('the wiki fix cell reads like its neighbours', () => {
  // `--fix 'x db gen'` landed on the page as bare text between rows whose commands are in
  // backticks (W-DB, plan 101): a command a reader copies is code, and the page says so.
  const cellOf = (fix: string): string => {
    const page = rowIn(
      '## Core and runtime\n\n| Code | Means | Typical cause | Fix |\n|---|---|---|---|\n| `X_A` | a | a | `x a` |\n',
      {
        code: 'X_CORE_PROBE',
        pkg: 'core',
        title: 't',
        cause: 'c',
        fix,
      },
    );
    const row = page.split('\n').find((line) => line.startsWith('| `X_CORE_PROBE`')) ?? '';
    return row.split(' | ').at(-1)?.replace(/ \|$/, '') ?? '';
  };

  test('a bare command is written in backticks', () => {
    expect(cellOf('x db gen')).toBe('`x db gen`');
    expect(cellOf('x jobs ls --name <job> --state running --json')).toBe(
      '`x jobs ls --name <job> --state running --json`',
    );
  });

  test('a trailing shell comment stays prose, after the command', () => {
    expect(cellOf('x secrets show --json   # confirms the key id in force')).toBe(
      '`x secrets show --json` — confirms the key id in force',
    );
  });

  test('a fix the author already formatted is left exactly as written', () => {
    expect(cellOf('`x secrets init`, or export `ULTIMATE_SECRETS_KEY`')).toBe(
      '`x secrets init`, or export `ULTIMATE_SECRETS_KEY`',
    );
  });

  test('a pipe inside the command is still escaped for the table', () => {
    expect(cellOf('printf %s "$T" | x secrets set NAME')).toBe(
      '`printf %s "$T" \\| x secrets set NAME`',
    );
  });
});

describe('a codes array with a sentence per entry', () => {
  // `@ultimat3/cli`'s owned-codes array carries a comment per code; read as "no array", the
  // planner wrote the title alone and the package no longer typechecked.
  test('the code joins the array as well as the titles', () => {
    const source = [
      'export const X_OWNED_ERROR_CODES = [',
      "  'X_A',",
      '  // why the next one exists',
      "  'X_B',",
      '] as const;',
      'export const X_TITLES: Readonly<Record<string, string>> = {',
      "  X_A: 'a',",
      "  X_B: 'b',",
      '};',
    ].join('\n');
    const out = registerIn(source, 'packages/x/src/error-codes.ts', {
      code: 'X_C',
      pkg: 'x',
      title: 'c',
      cause: 'c',
      fix: 'x doctor --json',
    });
    expect(out).toContain("  'X_C',\n] as const;");
    expect(out).toContain("  X_C: 'c',");
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
        '--cause',
        'what usually makes it happen',
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
    const argv = (code: string) => [
      code,
      '--package',
      'money',
      '--title',
      't',
      '--cause',
      'what usually makes it happen',
      '--fix',
      'f',
      '--status',
      '400',
    ];
    expect(await refusal(newErrorCode(dir, argv('X_CURRENCY_UNKNOWN')))).toBe(
      'X_NEW_ERROR_CODE_EXISTS',
    );
    expect(await refusal(newErrorCode(dir, argv('X_ABORTED')))).toBe('X_NEW_ERROR_CODE_EXISTS');
    // …and the refusal on the PAGE left the package file alone, though it was planned first.
    expect(await read(dir, 'packages/money/src/errors.ts')).not.toContain("'X_ABORTED'");
  });

  test('a malformed code, a missing flag, an unknown package or section is refused', async () => {
    const dir = await fixtureRoot();
    const ok = [
      '--package',
      'money',
      '--title',
      't',
      '--cause',
      'what makes it happen',
      '--fix',
      'f',
      '--status',
      '400',
    ];
    expect(await refusal(newErrorCode(dir, ['x_lower', ...ok]))).toBe('X_NEW_ERROR_CODE_INVALID');
    expect(await refusal(newErrorCode(dir, ['X_A_B', '--package', 'money']))).toBe(
      'X_NEW_ERROR_CODE_INVALID',
    );
    expect(
      await refusal(
        newErrorCode(dir, [
          'X_A_B',
          '--package',
          'nope',
          '--title',
          't',
          '--cause',
          'what makes it happen',
          '--fix',
          'f',
        ]),
      ),
    ).toBe('X_NEW_ERROR_CODE_INVALID');
    expect(await refusal(newErrorCode(dir, ['X_A_B', ...ok, '--section', 'No such section']))).toBe(
      'X_NEW_ERROR_CODE_INVALID',
    );
  });
});

describe('the cause cell is its own sentence, never the title again', () => {
  const base = ['X_MONEY_PROBE', '--package', 'money', '--title', 'a probe', '--fix', 'f'];

  test('no --cause is refused before anything is written', async () => {
    const dir = await fixtureRoot();
    const before = await read(dir, WIKI_PAGE);
    expect(await refusal(newErrorCode(dir, [...base, '--status', '400']))).toBe(
      'X_NEW_ERROR_CODE_INVALID',
    );
    expect(await read(dir, WIKI_PAGE)).toBe(before);
  });

  test('a --cause that repeats the title is refused — the row would say one thing twice', async () => {
    const dir = await fixtureRoot();
    const argv = [...base, '--cause', ' A probe ', '--status', '400'];
    expect(await refusal(newErrorCode(dir, argv))).toBe('X_NEW_ERROR_CODE_INVALID');
  });

  test('the row carries title, cause and fix in their own cells', async () => {
    const dir = await fixtureRoot();
    await newErrorCode(dir, [...base, '--cause', 'what usually causes it', '--status', '400']);
    const row = (await read(dir, WIKI_PAGE))
      .split('\n')
      .find((line) => line.startsWith('| `X_MONEY_PROBE`'));
    expect(row).toBe('| `X_MONEY_PROBE` | a probe | what usually causes it | `f` |');
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
          cause: 'c',
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
