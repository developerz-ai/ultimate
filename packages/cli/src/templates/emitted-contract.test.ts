// The generators' output, held to the gate the same generators ship. A file `x new` writes that the
// scaffolded app's own `lint` or `errors` step rejects is a red first gate over code nobody typed —
// and CI's scaffold-smoke job is a full install away, so the rules run here, over the strings, where
// a failure names the template that emitted them.

import { describe, expect, test } from 'bun:test';
import { fixProblem, staticFix } from '../error-contract';
import { citedCommandProblem, loadCommandCatalog } from '../fix-command';
import { scaffoldVariants } from '../scaffold-fixture';
import { scanFixes } from '../ts-scan';

interface EmittedText {
  /** `x new` / `x new --no-example` — which invocation wrote it, so a failure names one. */
  readonly variant: string;
  readonly path: string;
  readonly contents: string;
}

/** Every text file every documented invocation writes. The app icon is bytes and has no lines. */
const emitted = (): readonly EmittedText[] =>
  scaffoldVariants().flatMap((variant) =>
    variant.files.flatMap((file) =>
      typeof file.contents === 'string'
        ? [{ variant: variant.name, path: file.path, contents: file.contents }]
        : [],
    ),
  );

const at = (file: EmittedText, line?: number): string =>
  `${file.variant}: ${file.path}${line === undefined ? '' : `:${line}`}`;

describe('unit · every emitted file survives the formatter the scaffold configures', () => {
  // `biome check .` is the scaffolded app's whole `lint` step, and its formatter is not advisory:
  // ONE generated `page.test.ts` ending in a blank line was the single error behind `lint` being
  // red in every app `x new` has ever produced — an `x g route` template, reported against the app.
  test('a generated file ends with exactly one newline', () => {
    const offenders = emitted()
      .filter((file) => !file.contents.endsWith('\n') || file.contents.endsWith('\n\n'))
      .map((file) => at(file));
    expect(offenders).toEqual([]);
  });

  test('no generated line carries trailing whitespace', () => {
    const offenders = emitted().flatMap((file) =>
      file.contents
        .split('\n')
        .flatMap((line, index) => (/[ \t]+$/.test(line) ? [at(file, index + 1)] : [])),
    );
    expect(offenders).toEqual([]);
  });
});

describe('unit · every generated test says what it pins before it imports', () => {
  // 41 of the 44 `<file>.test.ts` the generators write opened with an import, and the three that
  // did not (backfill, island, guard) had no principle in common. A scaffolded app's generated
  // tests are the model its agent copies, so the scaffold was teaching the exception: 70% of this
  // repo's own test files carry the 1–4 line header the conventions ask for. Enforced rather than
  // written down, because the 30% that do not are what an unenforced convention decays into.
  test('a generated <file>.test.ts opens with a comment', () => {
    const offenders = emitted()
      .filter((file) => /\.test\.tsx?$/.test(file.path) && !file.contents.startsWith('//'))
      .map((file) => at(file));
    expect(offenders).toEqual([]);
  });
});

describe('unit · every emitted fix: is one the generated app can run', () => {
  // The same two rules `checkErrorFixes` applies to this repo's own source, applied to the source
  // the generators write. `templates/action.ts` emitted a `fix:` citing `x db studio` — a PLANNED
  // subcommand that exits X_NOT_IMPLEMENTED — so every `x g action` wrote a fresh
  // X_ERROR_FIX_INVALID into the app it was scaffolding.
  test('no generated fix line is empty, advisory, or cites a command this build does not ship', async () => {
    const catalog = await loadCommandCatalog();
    const offenders = emitted()
      .filter((file) => /\.tsx?$/.test(file.path))
      .flatMap((file) =>
        scanFixes(file.contents, file.path).flatMap((site) => {
          const problem = fixProblem(site.fix) ?? citedCommandProblem(staticFix(site.fix), catalog);
          return problem === undefined ? [] : [`${at(file, site.line)} — ${problem}`];
        }),
      );
    expect(offenders).toEqual([]);
  });
});

describe('unit · the emitted biome config and the emitted biome dependency name one version', () => {
  /**
   * `''` when `x new` writes no such file. Deliberately not a throw: a missing fixture is this
   * test's own failure, not a condition an operator is ever handed, and it reads better as the
   * assertion below naming the file than as a stack out of a helper.
   */
  const rootFile = (name: string): string =>
    emitted().find((entry) => entry.path === name)?.contents ?? '';

  // A `$schema` pinned to one version beside a range that resolves to another is a config the
  // installed Biome reports as out of date on every run — and, once the two diverge far enough, a
  // rule set the app declared and the binary does not have. Pinned exactly, spelled once.
  test('biome.json names the version package.json installs', () => {
    const biome = rootFile('biome.json');
    const pkg = rootFile('package.json');
    // Named first, so a scaffold that stopped writing either file fails here rather than by
    // comparing one absent version against another and passing.
    expect({ 'biome.json': biome === '' }).toEqual({ 'biome.json': false });
    expect({ 'package.json': pkg === '' }).toEqual({ 'package.json': false });
    const schema = /schemas\/(?<version>[\d.]+)\/schema\.json/.exec(biome)?.groups?.['version'];
    const declared = /"@biomejs\/biome":\s*"(?<range>[^"]+)"/.exec(pkg)?.groups?.['range'];
    expect(schema).toBeDefined();
    expect(declared).toBe(schema as string);
  });
});
