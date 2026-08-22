// The titles registered here render as the first line of every money error a caller sees — in
// the terminal, `--json`, and `x errors explain`. A code with no title, or a title the registry
// disagrees with, is a broken contract nothing else here would catch.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode, renderThrowable } from '@ultimat3/core';
import {
  allocationInvalid,
  currencyDeclarationInvalid,
  currencyMismatch,
  currencyRedefined,
  currencyRequired,
  currencyUnknown,
  decimalNotNumeric,
  decimalTooPrecise,
  MONEY_ERROR_CODES,
  MONEY_ERROR_TITLES,
  moneyNotInteger,
  notRoundable,
  rateMissing,
  rescaleNotExact,
  scaleInvalid,
  scaleNotWidening,
  scaleOverflow,
} from './errors';
import { fromDecimal, money } from './money';

describe('MONEY_ERROR_TITLES', () => {
  test('has exactly one entry per code in MONEY_ERROR_CODES, and no others', () => {
    expect(Object.keys(MONEY_ERROR_TITLES).sort()).toEqual([...MONEY_ERROR_CODES].sort());
  });

  test('every title is a non-empty string', () => {
    for (const code of MONEY_ERROR_CODES) {
      expect(typeof MONEY_ERROR_TITLES[code]).toBe('string');
      expect(MONEY_ERROR_TITLES[code].length).toBeGreaterThan(0);
    }
  });
});

describe('error code registry', () => {
  test('every money code is registered with its declared title', () => {
    for (const code of MONEY_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
      expect(describeErrorCode(code).title).toBe(MONEY_ERROR_TITLES[code]);
    }
  });

  test('every money code documents at its own X_* url', () => {
    for (const code of MONEY_ERROR_CODES) {
      expect(describeErrorCode(code).docs).toBe(`https://ultimate.dev/errors/${code}`);
    }
  });
});

/**
 * Every value here is legal input somewhere: `O'Reilly Points` is a currency name an app may
 * register, and a trailing newline survives `fromDecimal`'s own `.trim()` into the value the error
 * echoes. None of them contains a parenthesis, because `scanFix` below counts those to find where
 * a call ends — a paren inside a *correctly* escaped literal would make the reader cut early and
 * report a defect that is not there.
 */
const HOSTILE = ["O'Reilly", 'a "quoted" name', 'back\\slash', 'two\nlines', "';drop"] as const;

/** One error per factory that can put caller-controlled text in a `fix:`, for one hostile value. */
function fixLines(hostile: string): readonly string[] {
  return [
    moneyNotInteger(1.5, hostile).fix,
    notRoundable(Number.NaN).fix,
    decimalTooPrecise(hostile, 'USD', 2).fix,
    decimalTooPrecise('1.23456', hostile, 2).fix,
    decimalNotNumeric(hostile, hostile).fix,
    scaleInvalid(99).fix,
    scaleOverflow(6, hostile, 2).fix,
    scaleNotWidening(6, 2).fix,
    rescaleNotExact({ minor: 1, currency: hostile }, 6, 2).fix,
    currencyUnknown(hostile).fix,
    currencyDeclarationInvalid('reason', hostile).fix,
    currencyRedefined(hostile, { exponent: 2, name: hostile }, { exponent: 3, name: hostile }).fix,
    currencyRequired(hostile).fix,
    currencyMismatch(hostile, hostile).fix,
    allocationInvalid(hostile).fix,
    rateMissing(hostile, hostile).fix,
  ];
}

interface FixScan {
  /** Every `name(...)` expression, sliced with quoting respected. */
  readonly calls: readonly string[];
  /** Did the line end outside every quote and every paren it opened? */
  readonly balanced: boolean;
}

/**
 * A deliberately dumb reader: it tracks parens, and quotes only *inside* an argument list, which
 * is what makes it a witness rather than a second implementation. Prose is not source — a fix line
 * says "the currency's own minor unit" and that apostrophe opens nothing. On a well-formed line it
 * hands back exactly the pasteable calls; on `assertCurrency('O'R')` it ends inside a string with
 * the call still open, and `balanced` is the fail.
 */
function scanFix(fix: string): FixScan {
  const calls: string[] = [];
  let start = -1;
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < fix.length; index += 1) {
    const char = fix[index] as string;
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (depth > 0 && (char === "'" || char === '"' || char === '`')) {
      quote = char;
    } else if (char === '(') {
      if (depth === 0) {
        const name = /[A-Za-z_$][\w$]*$/.exec(fix.slice(0, index));
        start = name === null ? -1 : index - name[0].length;
      }
      depth += 1;
    } else if (char === ')' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        calls.push(fix.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return { calls, balanced: quote === undefined && depth === 0 };
}

/** Compiles the source without running it — a syntax error throws, the body never executes. */
function parses(source: string): boolean {
  try {
    new Function(`if (false) { ${source} }`);
    return true;
  } catch {
    return false;
  }
}

/** A control character is the other way a pasted line stops parsing, and it needs no quote. */
function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0;
    if (point < 0x20 || point === 0x7f) return true;
  }
  return false;
}

describe('a fix line that a caller can paste', () => {
  test('stays parsable source whatever text the caller supplied', () => {
    for (const hostile of HOSTILE) {
      for (const fix of fixLines(hostile)) {
        // Axiom 4: a `fix:` is READ AND RUN. A quote that closes the literal early emits
        // JavaScript that does not parse, which is worse than no fix at all — it looks runnable.
        expect({ fix, balanced: scanFix(fix).balanced }).toEqual({ fix, balanced: true });
        for (const call of scanFix(fix).calls) {
          expect({ call, parses: parses(call) }).toEqual({ call, parses: true });
        }
      }
    }
  });

  test('stays one line — `format()` renders it as `  fix:   <one line>`', () => {
    for (const hostile of HOSTILE) {
      for (const fix of fixLines(hostile)) {
        expect({ fix, control: hasControlCharacter(fix) }).toEqual({ fix, control: false });
      }
    }
  });

  test("still names the caller's own code when that code is usable", () => {
    // The escaping must not cost the instruction its point: 'usd' is the common arrival, and the
    // fix that answers it has to say USD.
    expect(currencyUnknown('usd').fix).toContain("'USD'");
    expect(currencyMismatch('EUR', 'USD').fix).toContain("'EUR'");
    expect(decimalTooPrecise('12.99999', 'EUR', 2).fix).toContain('{ scale: 5 }');
  });
});

/**
 * Every arrival `money()` can hand `moneyNotInteger`: a fractional minor, a magnitude past a safe
 * integer, float drift, an exponent spelling with no plain decimal form, and a non-finite.
 */
const NOT_INTEGER_ARRIVALS: readonly number[] = [
  12.345,
  1e21,
  0.1 + 0.2,
  12.99,
  1e-7,
  Number.NaN,
  Number.POSITIVE_INFINITY,
];

describe('the fix line for X_MONEY_NOT_INTEGER', () => {
  /**
   * Executes the pasted text with this package's own exports in scope. `new Function` and not a
   * lookup table on purpose: the claim under test is that the TEXT runs, and a table would
   * re-implement the line instead of executing it.
   */
  function run(call: string): void {
    const built = new Function('money', 'fromDecimal', `return ${call};`) as (
      moneyFn: typeof money,
      fromDecimalFn: typeof fromDecimal,
    ) => unknown;
    built(money, fromDecimal);
  }

  test('names only calls that RUN — a fix raising the code it answers is not an instruction', () => {
    // The shipped line was `fromDecimal('<minor>', '<ccy>')` for every arrival: it threw
    // X_MONEY_NOT_INTEGER straight back for 12.345, and `fromDecimal('1e+21', …)` is a spelling
    // `DECIMAL` refuses. Axiom 4 — a `fix:` is read and RUN.
    const raised: { minor: string; call: string; error: string }[] = [];
    for (const minor of NOT_INTEGER_ARRIVALS) {
      for (const call of scanFix(moneyNotInteger(minor, 'USD').fix).calls) {
        try {
          run(call);
        } catch (error) {
          raised.push({ minor: String(minor), call, error: renderThrowable(error) });
        }
      }
    }
    expect(raised).toEqual([]);
  });

  test('withdraws the offer where no call could run, rather than naming one that throws', () => {
    // `1e21` fits no `minor` at any scale and `NaN` is not an amount at all, so both get an edit
    // instead of a call. An instruction with no call is honest; one whose call throws is worse
    // than none, because it looks runnable.
    for (const minor of [1e21, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect({
        minor: String(minor),
        calls: scanFix(moneyNotInteger(minor, 'USD').fix).calls,
      }).toEqual({ minor: String(minor), calls: [] });
      expect(moneyNotInteger(minor, 'USD').fix).not.toContain('fromDecimal');
    }
    // And it is withdrawn nowhere else: every arrival a call CAN answer still names one.
    for (const minor of [12.345, 0.1 + 0.2, 12.99, 1e-7]) {
      expect({
        minor: String(minor),
        named: scanFix(moneyNotInteger(minor, 'USD').fix).calls.length > 0,
      }).toEqual({ minor: String(minor), named: true });
    }
  });
});
