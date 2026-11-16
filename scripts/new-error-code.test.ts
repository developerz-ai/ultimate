// The generator, proved on a throwaway root holding copies of real `errors.ts` files and of the
// real error-code pages — never the committed ones. Every refusal leaves every file as found,
// because a registration without its row is the gap this exists to close.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
// why: Bun has no mkdtemp/rm of its own; a unique directory per run keeps test workers apart.
import { mkdir } from 'node:fs/promises';
import { planPageEdits } from './lib/error-code-page-edit';
import { codeRows, errorCodePageFiles, ownerOfPage, ownerPage } from './lib/error-code-pages';
import { codeRowFor, registerIn } from './lib/error-code-plan';
import { snapshotReader } from './lib/planned-writes';
import { REPO_SCAN_TIMEOUT_MS } from './lib/run';

// Reads the real tree or spawns real processes, so it runs on the repo-scan backstop.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);
afterAll(removeFixtureRoots);

import { ScriptError } from './lib/script-error';
import { newErrorCode, STATUS_BACKLOG, statusTableFor, WIKI_PAGE } from './new-error-code';
import {
  fixtureRoot,
  ROOT,
  read,
  refusal,
  removeFixtureRoots,
  transpiles,
} from './new-error-code.fixtures';

describe('a new code, registered and documented in one edit', () => {
  test('money: into the codes array AND the titles table, a row on its page, the index', async () => {
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
    expect(result.written).toEqual([
      'packages/money/src/errors.ts',
      ownerPage('money'),
      WIKI_PAGE,
      statusTableFor('money'),
    ]);
    const errors = await read(dir, 'packages/money/src/errors.ts');
    expect(errors).toContain("  'X_MONEY_ROUNDING_LOST',\n] as const;");
    expect(errors).toContain(
      "  X_MONEY_ROUNDING_LOST: 'a conversion that can\\'t keep its minor units',\n};",
    );
    expect(transpiles(errors)).toBe(true);

    const page = await read(dir, ownerPage('money'));
    const codes = codeRows(page).map((row) => row.codes[0] ?? '');
    // Present, and at its place in code order: the rows either side sort below and above it.
    const at = codes.indexOf('X_MONEY_ROUNDING_LOST');
    expect(at).toBeGreaterThan(0);
    expect((codes[at - 1] ?? '') < 'X_MONEY_ROUNDING_LOST').toBe(true);
    expect((codes[at + 1] ?? 'X_~') > 'X_MONEY_ROUNDING_LOST').toBe(true);
    expect(page).toContain('more \\| decimals');
    // …and the index lists it, so no second command is needed for the gate to stay green.
    expect(await read(dir, WIKI_PAGE)).toContain(
      "| X_MONEY_ROUNDING_LOST | a conversion that can't keep its minor units | [money](Error-Codes-money) |",
    );
  });

  test('the row goes in the CODE table, never the notes table further down', async () => {
    // Scraping's page carries a retry-override table (`| Set | Codes | Effect |`) in its notes.
    const dir = await fixtureRoot();
    const before = await read(dir, ownerPage('scraping'));
    const input = { code: 'X_SCRAPE_ZZ_PROBE', pkg: 'scraping', title: 't', cause: 'c', fix: 'f' };
    const [page] = await planPageEdits({
      root: dir,
      read: snapshotReader(dir, new Map()),
      input,
      owner: 'scraping',
    });
    const lines = (page?.text ?? '').split('\n');
    const at = lines.indexOf(codeRowFor(input));
    expect(at).toBeGreaterThan(0);
    expect(lines.indexOf('| Set | Codes | Effect |')).toBeGreaterThan(at);
    expect(lines[at - 1]).toStartWith('| `X_SCRAPE_');
    expect(page?.text.replace(`${codeRowFor(input)}\n`, '')).toBe(before);
  });

  test("an owner's first code opens its page, linked from the regenerated index", async () => {
    const dir = await fixtureRoot();
    const input = { code: 'X_FRESH_PROBE', pkg: 'fresh', title: 't', cause: 'c', fix: 'f' };
    const [page, index] = await planPageEdits({
      root: dir,
      read: snapshotReader(dir, new Map()),
      input,
      owner: 'fresh',
    });
    expect(page?.path).toBe('wiki/Error-Codes-fresh.md');
    expect(page?.text).toStartWith('# Error codes: `@ultimat3/fresh`');
    expect(codeRows(page?.text ?? '').map((row) => row.codes)).toEqual([['X_FRESH_PROBE']]);
    expect(index?.text).toContain(
      '| `@ultimat3/fresh` | [Error-Codes-fresh](Error-Codes-fresh) | 1 |',
    );
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

describe('a registry kept as frozen declarations, not titles', () => {
  // `@ultimat3/schema` is tier 0 and cannot call `registerErrorCodes()`, so its codes are DATA core
  // reads: `Object.freeze({ X_A: { title } })` in `error-codes.ts`. The planner refused that shape,
  // so the one package with it had a second, hand-written way to add a code.
  const withSchema = async (): Promise<string> => {
    const dir = await fixtureRoot();
    await mkdir(`${dir}/packages/schema/src`, { recursive: true });
    await Bun.write(
      `${dir}/packages/schema/src/error-codes.ts`,
      Bun.file(`${ROOT}/packages/schema/src/error-codes.ts`),
    );
    return dir;
  };
  const args = (title: string): string[] => [
    'X_SCHEMA_PROBE',
    '--package',
    'schema',
    '--title',
    title,
    '--cause',
    'what usually makes it happen',
    '--fix',
    'edit the schema the cause names',
    '--off-socket',
  ];

  test('schema: the declaration joins the frozen object, the row and the pin land with it', async () => {
    const dir = await withSchema();
    await newErrorCode(dir, args('a probe'));
    const codes = await read(dir, 'packages/schema/src/error-codes.ts');
    expect(codes).toContain("    X_SCHEMA_PROBE: { title: 'a probe' },\n  });");
    expect(transpiles(codes)).toBe(true);
    expect(await read(dir, ownerPage('schema'))).toContain('| `X_SCHEMA_PROBE` | a probe |');
    // The pin joins schema's OFF_SOCKET group — never schema's UNDECIDED group. Opening a group a
    // package lacks is `new-error-code-status.test.ts`'s `time` case.
    const backlog = await read(dir, STATUS_BACKLOG);
    const offSocket = backlog.slice(backlog.indexOf('export const OFF_SOCKET'));
    // Read off the group, never a copy of the real row: the row grows with every schema code, and
    // Biome writes it on one line or one code per line depending on its width.
    const group = offSocket.slice(0, offSocket.indexOf('\n};\n'));
    expect(group).toMatch(/\n {2}schema: \[[^\]]*'X_SCHEMA_PROBE',?\s*\],\n/);
  });

  test('a title past 100 columns wraps the way Biome writes the entry', async () => {
    const dir = await withSchema();
    const title =
      'a probe whose title is long enough that the one-line entry would not fit the column';
    await newErrorCode(dir, args(title));
    expect(await read(dir, 'packages/schema/src/error-codes.ts')).toContain(
      `    X_SCHEMA_PROBE: {\n      title: '${title}',\n    },\n  });`,
    );
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
      ownerPage('core'),
      WIKI_PAGE,
      STATUS_BACKLOG,
    ]);
    const titles = await read(dir, 'packages/core/src/core-error-codes.ts');
    expect(titles).toContain("  X_CORE_PROBE_ONLY: 'a probe',\n} as const;");
    expect(transpiles(titles)).toBe(true);
    // The registry it could not add to is left exactly as found.
    expect(await read(dir, 'packages/core/src/error-codes.ts')).toBe(registry);
    expect(await read(dir, ownerPage('core'))).toContain('| `X_CORE_PROBE_ONLY` | a probe |');
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
      ownerPage('entity'),
      WIKI_PAGE,
      statusTableFor('entity'),
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
    const row = codeRowFor({ code: 'X_CORE_PROBE', pkg: 'core', title: 't', cause: 'c', fix });
    return row.split(' | ').at(-1)?.replace(/ \|$/, '') ?? '';
  };

  test('a bare command is written in backticks', () => {
    expect(cellOf('x db gen')).toBe('`x db gen`');
    expect(cellOf('x jobs list --name <job> --state running --json')).toBe(
      '`x jobs list --name <job> --state running --json`',
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

  test('a malformed code, a missing flag, an unknown package or a --section is refused', async () => {
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

  test('--section is retired: refused by name, pointing at the owner page, nothing written', async () => {
    const dir = await fixtureRoot();
    const before = await read(dir, ownerPage('money'));
    const argv = [
      'X_MONEY_PROBE',
      '--package',
      'money',
      '--title',
      't',
      '--cause',
      'c',
      '--fix',
      'f',
    ];
    const run = newErrorCode(dir, [...argv, '--status', '400', '--section', 'Money']);
    const error = await run.then(
      () => expect.unreachable('a --section run wrote'),
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ScriptError);
    expect((error as ScriptError).cause).toContain('--section is retired');
    expect((error as ScriptError).cause).toContain(ownerPage('money'));
    expect(await read(dir, ownerPage('money'))).toBe(before);
  });
});

describe('the cause cell is its own sentence, never the title again', () => {
  const base = ['X_MONEY_PROBE', '--package', 'money', '--title', 'a probe', '--fix', 'f'];

  test('no --cause is refused before anything is written', async () => {
    const dir = await fixtureRoot();
    const before = await read(dir, ownerPage('money'));
    expect(await refusal(newErrorCode(dir, [...base, '--status', '400']))).toBe(
      'X_NEW_ERROR_CODE_INVALID',
    );
    expect(await read(dir, ownerPage('money'))).toBe(before);
  });

  test('a --cause that repeats the title is refused — the row would say one thing twice', async () => {
    const dir = await fixtureRoot();
    const argv = [...base, '--cause', ' A probe ', '--status', '400'];
    expect(await refusal(newErrorCode(dir, argv))).toBe('X_NEW_ERROR_CODE_INVALID');
  });

  test('the row carries title, cause and fix in their own cells', async () => {
    const dir = await fixtureRoot();
    await newErrorCode(dir, [...base, '--cause', 'what usually causes it', '--status', '400']);
    const row = (await read(dir, ownerPage('money')))
      .split('\n')
      .find((line) => line.startsWith('| `X_MONEY_PROBE`'));
    expect(row).toBe('| `X_MONEY_PROBE` | a probe | what usually causes it | `f` |');
  });
});

describe('the real tree', () => {
  /** Every owner a page exists for, but the repo scripts: the packages that register codes. */
  const packages = async (): Promise<readonly string[]> =>
    (await errorCodePageFiles(ROOT)).flatMap((path) => {
      const owner = ownerOfPage(path);
      return owner === undefined || owner === 'scripts' ? [] : [owner];
    });

  test('every owner page names a package directory of this repository', async () => {
    const owners = await packages();
    expect(owners.length).toBeGreaterThan(20);
    for (const pkg of owners)
      expect(await Bun.file(`${ROOT}/packages/${pkg}/package.json`).exists()).toBe(true);
  });

  test('most real packages are in a shape it can add to — the rest are refused, never guessed', async () => {
    const shapes: Record<string, string> = {};
    for (const pkg of await packages()) {
      // A package that split its titles out (`ai`, `cli`, `jobs`) is probed where the planner writes.
      const split = Bun.file(`${ROOT}/packages/${pkg}/src/error-codes.ts`);
      const file = (await split.exists())
        ? split
        : Bun.file(`${ROOT}/packages/${pkg}/src/errors.ts`);
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
