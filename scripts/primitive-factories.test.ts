// The other half of "never invent a ninth primitive", made mechanical: an exported function whose
// return type IS an `Action` or a `JobHandle` is a factory over an existing primitive, and every
// one of them has a row in `PRIMITIVE_FACTORIES`. Prose counted them instead — "the fourth instance
// of the framework's factory rule", in three files that cannot see each other — and every ordinal
// was wrong the moment a fifth landed.
//
// Here rather than in `@ultimat3/core`, where the table lives: the table is tier 0 and the scan
// must read `ai`, `jobs`, `scraping` and `action`, which only a host check may do.

import { describe, expect, test } from 'bun:test';
import { PRIMITIVE_FACTORIES, PRIMITIVE_KINDS } from '@ultimat3/core';
import { repoRoot } from './lib/run';

/** `export function name<…>(…): Return {` — the return type read off the declaration, not inferred. */
const FUNCTION =
  /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^{}]*?>)?\s*\(([\s\S]*?)\)\s*:\s*([^{;]+?)\s*\{/g;
/** `export const name = (…): Return =>` — the same declaration in the other spelling. */
/** The kinds this scan can recognise from a return type. A subset of `PrimitiveKind`: the other
 *  five primitives are declared, never returned by a factory. */
type FactoryKind = 'action' | 'job' | 'mutator';

const ARROW =
  /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:<[^{}]*?>)?\s*\(([\s\S]*?)\)\s*:\s*([^=;]+?)\s*=>/g;
/** `export interface X<…> extends Action<…>` — how `LlmAction` is an `Action` without saying so. */
const EXTENDS =
  /export\s+interface\s+([A-Za-z_$][\w$]*)\s*(?:<[^{}]*?>)?\s*\n?\s*extends\s+([A-Za-z_$][\w$]*)\s*</g;

/**
 * The primitive types a factory hands back, and the kind each one means.
 *
 * `Mutator` is seeded HERE rather than left to the `extends` fixpoint, and that placement is the
 * whole rule: `Mutator extends Action<…>`, so the fixpoint would resolve it to `action` and a
 * `kind: 'mutator'` row would fail as a mismatch — reporting the table as wrong when the table is
 * right. `new Map(ROOTS)` seeds first and the fixpoint refuses a second entry for a name it
 * already holds, so the more specific answer wins by construction.
 */
const ROOTS: ReadonlyMap<string, FactoryKind> = new Map([
  ['Action', 'action'],
  ['JobHandle', 'job'],
  ['Mutator', 'mutator'],
]);

/**
 * The functions that BUILD a primitive rather than compose one, DERIVED from `PRIMITIVE_KINDS`: a
 * function named after one of the eight is that primitive's own constructor, so a row for it would
 * say the primitive is a factory over itself. `action()`, `job()` and `mutator()` are the three
 * that return one of these types today — and `mutator()` is why the set is derived rather than
 * typed out, because a hand-written `['action', 'job']` reported it as a missing row.
 *
 * By NAME and not by package, which is the trap this rule was briefed away from: `backfill()` ships
 * from `@ultimat3/jobs` and IS a row, so "everything outside `action`/`jobs`" would have excluded
 * the very entry the table exists to hold.
 */
const CONSTRUCTORS: ReadonlySet<string> = new Set<string>(PRIMITIVE_KINDS);

interface Declared {
  readonly factory: string;
  readonly pkg: string;
  readonly kind: FactoryKind;
  readonly at: string;
}

const sourceFiles = (): readonly string[] =>
  [...new Bun.Glob('packages/*/src/**/*.ts').scanSync({ cwd: repoRoot() })]
    .map((path) => path.split('\\').join('/'))
    .filter((path) => !path.includes('.test.'))
    .sort();

const read = (path: string): Promise<string> => Bun.file(`${repoRoot()}/${path}`).text();

/**
 * Every type that IS an `Action`/`JobHandle`, to a fixpoint. One hop is not enough and never was:
 * `llm()` returns `LlmAction`, which `extends Action` — so a scan keyed on the two root names alone
 * misses the framework's most-cited factory, which is exactly what a first draft of this file did.
 *
 * No pass ceiling, deliberately. `kinds` only ever GROWS, `kinds.has(name)` refuses a second entry
 * for a name, and the names come from a finite set of `extends` matches — so `!grew` is reached in
 * at most one pass per name and the loop cannot run forever. A `pass < 5` bound added nothing to
 * that and subtracted the tail: an inheritance chain six links deep stopped the scan with no
 * signal, and every factory below that link read as "not a primitive" — the vacuous green this
 * file's neighbours (`checkVocabulary` in `scripts/render-modes.ts`) each refuse by name.
 */
export function primitiveTypes(sources: readonly string[]): ReadonlyMap<string, FactoryKind> {
  const kinds = new Map(ROOTS);
  for (;;) {
    let grew = false;
    for (const source of sources) {
      for (const match of source.matchAll(EXTENDS)) {
        const name = match[1] as string;
        const base = kinds.get(match[2] as string);
        if (base === undefined || kinds.has(name)) continue;
        kinds.set(name, base);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return kinds;
}

/** Every exported function in one file whose DECLARED return type is a primitive. */
export function factoriesIn(
  path: string,
  source: string,
  kinds: ReadonlyMap<string, FactoryKind>,
): readonly Declared[] {
  const pkg = path.split('/')[1] ?? '';
  const found: Declared[] = [];
  for (const pattern of [FUNCTION, ARROW]) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1] as string;
      // The head of the return type, and only when the whole type is it: `getBackfill` answers
      // `JobHandle<BackfillInput> | undefined`, which is a registry lookup and not a factory.
      const head = /^([A-Za-z_$][\w$]*)\s*<[\s\S]*>$/.exec((match[3] as string).trim())?.[1];
      const kind = head === undefined ? undefined : kinds.get(head);
      if (kind === undefined || CONSTRUCTORS.has(name)) continue;
      found.push({ factory: name, pkg: `@ultimat3/${pkg}`, kind, at: path });
    }
  }
  return found;
}

const files = sourceFiles();
const sources = await Promise.all(files.map(read));
const kinds = primitiveTypes(sources);
const declared = files.flatMap((path, index) => factoriesIn(path, sources[index] as string, kinds));

const rowFor = (name: string) => PRIMITIVE_FACTORIES.find((entry) => entry.factory === name);

describe('unit · every primitive factory in the tree has a row in PRIMITIVE_FACTORIES', () => {
  test('the scan reaches a subtype of Action, not only the two root names', () => {
    // `LlmAction extends Action`, and `llm()` is the framework's most-cited factory. Without the
    // fixpoint this whole file is green over it.
    expect(kinds.get('LlmAction')).toBe('action');
    expect(declared.map((entry) => entry.factory)).toContain('llm');
  });

  test('every factory the tree declares is in the table, with the right package and kind', () => {
    for (const entry of declared) {
      const row = rowFor(entry.factory);
      if (row === undefined) {
        expect.unreachable(
          `${entry.at} exports ${entry.factory}(), which returns a ${entry.kind} — add { factory: '${entry.factory}', pkg: '${entry.pkg}', kind: '${entry.kind}' } to PRIMITIVE_FACTORIES in packages/core/src/registrar.ts`,
        );
      }
      expect({ pkg: row.pkg, kind: row.kind }).toEqual({ pkg: entry.pkg, kind: entry.kind });
    }
  });

  test('and every row in the table is a function the tree still exports', () => {
    const names = new Set(declared.map((entry) => entry.factory));
    for (const row of PRIMITIVE_FACTORIES) {
      if (names.has(row.factory)) continue;
      expect.unreachable(
        `PRIMITIVE_FACTORIES declares ${row.factory} from ${row.pkg} and no file in packages/*/src exports a function returning one — delete the row in packages/core/src/registrar.ts`,
      );
    }
  });

  /**
   * Every shipped row, asserted as a SET rather than derived from the scan — otherwise the two
   * tests above are a scan agreeing with itself, and a scan that found nothing would pass both.
   *
   * No COUNT here or in the test's name, which is CLAUDE.md's rule for this table stated one level
   * up: the list is the claim, and a title saying "the seven" is wrong the moment an eighth lands
   * — as it did, twice, in one release.
   */
  test('the shipped rows, spelled out, so a scan that finds nothing cannot pass', () => {
    expect(PRIMITIVE_FACTORIES.map((row) => `${row.pkg}.${row.factory}:${row.kind}`)).toEqual([
      '@ultimat3/action.transition:mutator',
      '@ultimat3/ai.agent:action',
      '@ultimat3/ai.agentJob:job',
      '@ultimat3/ai.hive:action',
      '@ultimat3/ai.llm:action',
      '@ultimat3/jobs.backfill:job',
      '@ultimat3/jobs.exportRows:job',
      '@ultimat3/jobs.purge:job',
      '@ultimat3/jobs.webhook:job',
      '@ultimat3/notify.notifier:job',
      '@ultimat3/scraping.scrape:job',
    ]);
    expect(declared).toHaveLength(PRIMITIVE_FACTORIES.length);
  });

  test('the row uses the full specifier a fix line can be pasted from, never a bare name', () => {
    for (const row of PRIMITIVE_FACTORIES) expect(row.pkg.startsWith('@ultimat3/')).toBe(true);
  });
});

describe('unit · the scan itself can fail', () => {
  const fixture = [
    'export interface LlmAction<I, O> extends Action<I, O> {',
    '  stream(): void;',
    '}',
    'export function llm<I, O>(def: LlmDef<I, O>): LlmAction<I, O> {',
    '  return built;',
    '}',
    'export function action<I, O>(def: Def<I, O>): Action<I, O> {',
    '  return self;',
    '}',
    'export function getBackfill(name: string): JobHandle<BackfillInput> | undefined {',
    '  return registry.get(name);',
    '}',
    'export const notAFactory = (n: number): string => String(n);',
    '',
  ].join('\n');

  test('a new factory is found, the primitive constructor is not, and a lookup is not', () => {
    const found = factoriesIn('packages/ai/src/llm.ts', fixture, primitiveTypes([fixture]));
    expect(found).toEqual([
      { factory: 'llm', pkg: '@ultimat3/ai', kind: 'action', at: 'packages/ai/src/llm.ts' },
    ]);
  });

  test('a Mutator-returning export is a MUTATOR factory, not an action one', () => {
    // `Mutator extends Action<…>`, so before `Mutator` was seeded as its own root the fixpoint
    // answered `action` here and a correct `kind: 'mutator'` row failed as a mismatch — the scan
    // reporting the table as wrong. `transition()` is the factory this exists for.
    const source =
      'export function transition<Row, S extends string>(def: Def<Row, S>): Mutator<In, Out> {\n  return built;\n}\n';
    expect(factoriesIn('packages/action/src/transition.ts', source, ROOTS)).toEqual([
      {
        factory: 'transition',
        pkg: '@ultimat3/action',
        kind: 'mutator',
        at: 'packages/action/src/transition.ts',
      },
    ]);
  });

  test('a subtype of Mutator keeps the mutator kind, not Action\u2019s', () => {
    // The fixpoint hop, from the specific root rather than through it: `extends Mutator` must not
    // walk on to `Action` and downgrade the answer.
    const source = [
      'export interface StateMutator<I, O> extends Mutator<I, O> {',
      '  moves(): readonly string[];',
      '}',
      'export function stateful<I, O>(def: Def<I, O>): StateMutator<I, O> {',
      '  return built;',
      '}',
      '',
    ].join('\n');
    const kinds = primitiveTypes([source]);
    expect(kinds.get('StateMutator')).toBe('mutator');
    expect(factoriesIn('packages/action/src/stateful.ts', source, kinds)).toEqual([
      {
        factory: 'stateful',
        pkg: '@ultimat3/action',
        kind: 'mutator',
        at: 'packages/action/src/stateful.ts',
      },
    ]);
  });

  test('a JobHandle-returning export is a job factory, by the same rule', () => {
    const source =
      'export function sweep<Row>(def: Def<Row>): JobHandle<Input> {\n  return handle;\n}\n';
    expect(factoriesIn('packages/jobs/src/sweep.ts', source, ROOTS)).toEqual([
      { factory: 'sweep', pkg: '@ultimat3/jobs', kind: 'job', at: 'packages/jobs/src/sweep.ts' },
    ]);
  });

  /**
   * Seven links, declared in the order that forces one hop per pass — a `pass < 5` ceiling stopped
   * at `A5` and every factory returning `A6`/`A7` read as "not a primitive", with nothing red.
   * Declared LAST-first so the walk cannot shortcut the chain within a single pass.
   */
  test('an inheritance chain deeper than any fixed pass count still reaches the root', () => {
    const chain = [7, 6, 5, 4, 3, 2, 1]
      .map(
        (n) =>
          `export interface A${String(n)} extends ${n === 1 ? 'Action' : `A${String(n - 1)}`}<I, O> {}`,
      )
      .join('\n');
    const kinds = primitiveTypes([chain]);
    expect(kinds.get('A7')).toBe('action');
    // The seven chain links, named — not a total, which also counts the roots and so moved when
    // `Mutator` was seeded. A count that mixes the fixture with the table breaks on an edit to
    // either, and says nothing about the chain when it does.
    for (let n = 1; n <= 7; n += 1) expect(kinds.get(`A${String(n)}`)).toBe('action');
  });

  /**
   * A cycle in `extends` terminates too: a name already in the map is never re-entered.
   *
   * `export` on both, because `EXTENDS` matches `export interface` and nothing else — a bare
   * `interface` fixture is read by the scanner as no declaration at all, so the test passed over
   * a cycle it never built and could not have failed if the walk had hung.
   */
  test('a cycle among unknown bases neither hangs nor adds a kind', () => {
    const kinds = primitiveTypes([
      'export interface P extends Q<I, O> {}\nexport interface Q extends P<I, O> {}',
    ]);
    expect([...kinds.keys()].sort()).toEqual([...ROOTS.keys()].sort());
  });
});
