// Pure types and constants. No I/O of any kind: no fs, no network, no database, no env reads.
// `Money` is @ultimat3/schema's, re-exported and never restated: one declaration of
// { minor, currency } is what makes an entity column, a form field and this module the same type.
import { defineError } from '@ultimat3/core';
import type { MoneyValue as Money } from '@ultimat3/schema';

export type { MoneyValue as Money } from '@ultimat3/schema';

interface CurrencyPair {
  readonly left: string;
  readonly right: string;
}

/**
 * Never a bare Error: an agent reading the failure needs the code, the cause and the exact command
 * that resolves it. Adding across currencies is a bug in the caller's data, not a runtime hiccup,
 * so it answers 422 and the fix names the conversion that has to happen first. One declaration
 * — `defineError` — holds the title, the status and the class; `guards/error-declared.ts` keeps
 * it the only way. No `docs:`: the link resolves from the code's registered descriptor.
 */
export const DocsSiteCurrencyMismatchError = defineError<CurrencyPair>({
  code: 'X_DOCS_SITE_CURRENCY_MISMATCH',
  title: 'money added across two currencies',
  status: 422,
  cause: (pair) =>
    `cannot add ${pair.left} to ${pair.right}: Money is only additive inside one currency`,
  fix: (pair) =>
    `bun test packages/domain/src/index.test.ts   # add() is defined only inside one currency — convert ${pair.right} to ${pair.left} before calling it`,
});

export const zero = (currency: string): Money => ({ minor: 0, currency });

export const add = (a: Money, b: Money): Money => {
  if (a.currency !== b.currency) {
    throw new DocsSiteCurrencyMismatchError({ left: a.currency, right: b.currency });
  }
  return { minor: a.minor + b.minor, currency: a.currency };
};
