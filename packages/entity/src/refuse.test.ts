// Single responsibility: every refusal a column or an invariant DECLARATION raises hands back an
// edit that repairs it. The defect this pins (issue #290): all 30 of them emitted
// `x entities describe column --json`, which answers `X_DECLARATION_UNKNOWN` — no entity is named
// `column`, and at declaration time there is no entity at all. A fix line that raises a second
// error is worse than none, because the reader debugs the wrong subsystem.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import {
  boolean,
  enumerated,
  integer,
  locale,
  money,
  text,
  timestamp,
  tz,
  url,
  uuid,
} from './columns';
import { arrayOf, bigint, bytes, date, decimal, json } from './columns-data';
import { iff, invariantColumns } from './expr';

const refusal = (
  run: () => unknown,
  label = 'refusal',
): { code: string; cause: string; fix: string } => {
  try {
    run();
  } catch (error) {
    if (error instanceof UltimateError)
      return { code: error.code, cause: error.cause, fix: error.fix };
    return expect.unreachable(`${label}: not an UltimateError`);
  }
  return expect.unreachable(`${label}: nothing was refused`);
};

const columns = { slug: text(), title: text() };
const c = invariantColumns<typeof columns>('refuse_test_posts', Object.keys(columns));

/**
 * `sameAs`'s refusal in `expr.ts` has no thunk here because no call can reach it: `eq` dispatches
 * to it only under `isColumnExpr(other)`, which IS `terms.has(other)`, so the `terms.get(other)`
 * below it never answers `undefined`. It carries a repaired fix line anyway — the branch is a
 * narrowing TypeScript needs, and an unreachable fix that is wrong is still one nobody may copy —
 * and it is counted here so the total below still pins every site.
 */
/**
 * Two now. The second is `transitions()`'s own `!meta.notNull` guard (`columns.ts`): `nullable()`
 * answers the general `Column`, which has no `transitions`, so TypeScript refuses that order of the
 * chain before the guard can run. It stays because a JS caller and a re-wrapped `$meta` both reach
 * it — and it carries the same fix line as its reachable twin below, which is what this file is for.
 */
const UNREACHABLE_SITES = 2;

/**
 * Every site that refuses through `refuseColumn` or `refuseInvariant`, one thunk each. The count
 * is asserted against the SOURCE below, so a refusal added without a case here fails this file
 * rather than shipping the next unfollowable fix line.
 */
const SITES: readonly (readonly [string, () => unknown])[] = [
  ['uuid value', () => uuid().$parse('nope')],
  ['text value', () => text().$parse(1)],
  ['integer value', () => integer().$parse(1.5)],
  ['boolean value', () => boolean().$parse('yes')],
  ['timestamp value', () => timestamp().$parse('nope')],
  ['enumerated value', () => enumerated(['draft', 'live']).$parse('gone')],
  ['url value', () => url().$parse('/settings')],
  ['tz declaration', () => tz(['CET'])],
  ['tz value', () => tz(['UTC']).$parse('Mars/Olympus')],
  ['locale declaration', () => locale(['english!'])],
  ['locale value', () => locale(['en']).$parse('fr')],
  ['money not an object', () => money().$parse(12)],
  ['money minor not a number', () => money().$parse({ minor: 'lots', currency: 'EUR' })],
  ['money minor a float', () => money().$parse({ minor: 12.34, currency: 'EUR' })],
  ['money minor past 2^53', () => money().$parse({ minor: 9007199254740994, currency: 'EUR' })],
  ['money currency', () => money().$parse({ minor: 1234, currency: 'euro' })],
  ['money scale', () => money().$parse({ minor: 1234, currency: 'EUR', scale: 99 })],
  ['column name', () => text().column('Created At')],
  ['column default', () => json(t.object({ a: t.string })).default({ a: 'x' })],
  ['json value', () => json(t.object({ seats: t.number })).$parse({ seats: 'four' })],
  ['bigint past 2^53', () => bigint().$parse(9007199254740994)],
  ['bigint digits', () => bigint().$parse('1.5')],
  ['decimal precision without scale', () => decimal({ precision: 18 })],
  ['decimal precision range', () => decimal({ precision: 0, scale: 0 })],
  ['decimal scale range', () => decimal({ precision: 5, scale: 9 })],
  ['decimal value', () => decimal().$parse({})],
  ['decimal too many places', () => decimal({ precision: 5, scale: 2 }).$parse('1.234')],
  ['decimal does not fit', () => decimal({ precision: 5, scale: 2 }).$parse('1234.00')],
  ['date invalid', () => date().$parse(new Date('nope'))],
  ['date format', () => date().$parse('nope')],
  ['bytes value', () => bytes().$parse('nope')],
  ['array value', () => arrayOf(text()).$parse('nope')],
  ['invariant matches flags', () => c.slug.matches(/^a+$/g)],
  // A construct, not a flag: `\b` is a word boundary to `.test()` and a BACKSPACE to the CHECK.
  ['invariant matches construct', () => c.slug.matches(/\bfoo/)],
  // A column list where a predicate belongs — the one operand `iff` cannot render.
  ['invariant iff unique', () => iff(c.unique(['slug']), c.title.isNotNull())],
  ['searchable kind', () => uuid().searchable()],
  // A JS caller reaching the weight refusal — the union makes it unwritable in TypeScript, and
  // `.searchable(input.weight)` from parsed JSON is exactly how it arrives anyway.
  ['searchable weight', () => text().searchable('Z' as 'A')],
  ['transitions table', () => enumerated(['a', 'b']).transitions({ a: ['c'], b: [] } as never)],
  [
    'transitions nullable',
    () =>
      enumerated(['a', 'b'])
        .transitions({ a: ['b'], b: [] })
        .nullable(),
  ],
];

/** A fix is an instruction: a call to paste, a command to run, or an edit naming a file. */
const ACTIONABLE = /\b[A-Za-z_$][\w$.]*\(|(?:^|[\s;|&("'`])x\s+[a-z]|\b(?:bun|bunx)\b/;

/**
 * A method name with nothing to its left. `toFixed(2)` shipped that way: the name does not resolve
 * at all, so an agent pasting it got a `ReferenceError` instead of a repaired value — and
 * `ACTIONABLE` above accepts it, because a call is what it looks for.
 */
const UNBOUND_METHOD =
  /(?:^|[\s;|&("'`[{])(?:toFixed|toPrecision|toLocaleString|toLocaleDateString|padStart|padEnd|slice|replace|replaceAll|trim|test|encode)\s*\(/;

/** A transform with nothing to transform: `Math.round()` answers `NaN`, and it also shipped. */
const OPERANDLESS =
  /\b(?:Math\.[A-Za-z]+|Number|String|Boolean|BigInt|parseInt|parseFloat)\s*\(\s*\)/;

describe('unit · every column and invariant refusal hands back an edit', () => {
  test('none cites a command that names no entity', () => {
    for (const [label, run] of SITES) {
      const { code, fix } = refusal(run, label);
      expect(code, label).toBe('X_INVARIANT_VIOLATED');
      expect(fix, label).not.toContain('x entities describe column');
      expect(fix, label).not.toContain('x entities describe invariant');
    }
  });

  test('none is empty, a placeholder, or advice with nothing to run', () => {
    for (const [label, run] of SITES) {
      const { fix } = refusal(run, label);
      expect(fix.trim(), label).not.toBe('');
      expect(fix, label).not.toMatch(/<[a-z][a-z ]*>/);
      expect(ACTIONABLE.test(fix), `${label}: ${fix}`).toBe(true);
    }
  });

  /**
   * A call in a fix line is something to PASTE, so it needs its receiver and its operand. Both
   * fragments this pins really shipped, and `ACTIONABLE` accepted both — an agent that followed
   * either repaired nothing and then debugged the wrong subsystem, which is this file's own defect
   * one level down from the command it already refuses.
   */
  test('every call it hands back carries its receiver and its operand', () => {
    for (const [label, run] of SITES) {
      const { fix } = refusal(run, label);
      expect(UNBOUND_METHOD.test(fix), `${label}: ${fix}`).toBe(false);
      expect(OPERANDLESS.test(fix), `${label}: ${fix}`).toBe(false);
    }
  });

  test('and the two that shipped broken now name the value they convert', () => {
    // Rounding a decimal is the caller's decision and `decimal()` holds a STRING, so the repair
    // has to end in one; the minor-unit repair carries the ×100 or it converts nothing.
    expect(refusal(() => decimal({ precision: 5, scale: 2 }).$parse('1.234')).fix).toContain(
      'Number(value).toFixed(2)',
    );
    expect(refusal(() => money().$parse({ minor: 12.34, currency: 'EUR' })).fix).toContain(
      'Math.round(amount * 100)',
    );
  });

  test('none leaks the value it refused — a column message reaches the log line', () => {
    expect(refusal(() => uuid().$parse('hunter2-the-password')).fix).not.toContain('hunter2');
    expect(refusal(() => money().$parse({ minor: 12.34, currency: 'EUR' })).fix).not.toContain(
      '12.34',
    );
  });

  test('the repair carries the numbers the author wrote, not a generic one', () => {
    expect(refusal(() => decimal({ precision: 5, scale: 9 })).fix).toContain(
      'decimal({ precision: 5, scale: 2 })',
    );
    expect(refusal(() => decimal({ precision: 5, scale: 2 }).$parse('1.234')).fix).toContain(
      'decimal({ precision: 6, scale: 3 })',
    );
    expect(refusal(() => decimal({ precision: 5, scale: 2 }).$parse('1234.00')).fix).toContain(
      'decimal({ precision: 6, scale: 2 })',
    );
    expect(
      refusal(() => money().$parse({ minor: 1234, currency: 'EUR', scale: 99 })).fix,
    ).toContain('scale: 6');
  });

  /**
   * The pasted predicate must not carry the flag the refusal is about: `.test()` under `g` or `y`
   * advances `lastIndex`, so a rule copied from the fix line would answer differently for the
   * second row than for the first. It shipped as `/…/${pattern.flags}` — the author's flags,
   * verbatim, including the stateful one.
   */
  test('the matches() predicate it hands back is stateless', () => {
    expect(refusal(() => c.slug.matches(/^a+$/gy)).fix).toContain(
      'matches((value) => /^a+$/.test(value))',
    );
    expect(refusal(() => c.slug.matches(/^a+$/gm)).fix).toContain(
      'matches((value) => /^a+$/m.test(value))',
    );
  });

  /**
   * A construct refusal has two fix lines and they are not interchangeable. Where a portable
   * spelling exists the author keeps their CHECK and edits one class; where none does, the only
   * honest repair is the predicate, which reports `sql: null` — offering "use a predicate" for a
   * `\w` would trade an enforced constraint for an app-only one over a two-character edit.
   */
  test('a construct with a portable spelling is repaired in place, not downgraded', () => {
    const fix = refusal(() => c.slug.matches(/^\w+$/)).fix;
    expect(fix).toContain('[A-Za-z0-9_]');
    expect(fix).toContain('x db gen');
    expect(fix).not.toContain('matches((value)');
  });

  test('a construct with no portable spelling is handed the app-only predicate', () => {
    const fix = refusal(() => c.slug.matches(/\bfoo/)).fix;
    expect(fix).toContain('matches((value) => /\\bfoo/.test(value))');
    expect(fix).toContain('sql: null');
  });

  test('the cause names the construct and where it sits, so the author can find it', () => {
    const cause = refusal(() => c.slug.matches(/^ab.cd$/)).cause;
    expect(cause).toContain('index 3');
    expect(cause).toContain('newline');
  });
});

/**
 * Code only. A whole-line comment naming `invariantViolated('column', …)` is prose ABOUT the
 * defect — `refuse.ts`'s own header is exactly that — and reading it as a call site would make
 * documenting the rule the way to break it.
 */
const codeOf = (source: string): string =>
  source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .join('\n');

const sourceOf = async (file: string): Promise<string> =>
  codeOf(await Bun.file(`${import.meta.dir}/${file}`).text());

const sources = async (): Promise<readonly (readonly [string, string])[]> => {
  const files: [string, string][] = [];
  for await (const file of new Bun.Glob('*.ts').scan({ cwd: import.meta.dir })) {
    if (file.endsWith('.test.ts')) continue;
    files.push([file, await sourceOf(file)]);
  }
  return files;
};

describe('unit · the fix line cannot regress to a lookup', () => {
  /**
   * The mechanical half. A string LITERAL in the entity-name position is exactly the defect:
   * every honest caller passes a value (`entity.$name`, `table`, `name`), and a literal is
   * someone inventing an entity that `x entities describe` will not find.
   */
  test('no invariantViolated() call names its entity with a literal', async () => {
    const offenders: string[] = [];
    for (const [file, source] of await sources()) {
      for (const match of source.matchAll(/invariantViolated\(\s*(['"`])/g)) {
        offenders.push(`${file}: invariantViolated(${match[1] ?? ''}…`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every refusal site has a case above', async () => {
    let sites = 0;
    for (const [file, source] of await sources()) {
      if (file === 'refuse.ts') continue;
      sites += [...source.matchAll(/\brefuse(?:Column|Invariant)\(/g)].length;
    }
    expect(sites).toBe(SITES.length + UNREACHABLE_SITES);
  });
});
