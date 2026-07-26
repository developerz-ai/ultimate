// Pure formatting core behind <Money>. Split out so the rule "format through the
// injected locale, never an ambient default" is testable without a renderer.

import {
  type FormatMoneyOptions,
  formatMoney,
  type Money,
  money as makeMoney,
} from '@ultimat3/money';
import { invalidValueError } from '../errors';

/** A bare number is minor units in the context currency. */
export type MoneyInput = Money | number;

export type MoneyFormatter = (
  amount: Money,
  locale: string,
  options?: FormatMoneyOptions,
) => string;

export interface MoneyViewOptions {
  value: MoneyInput;
  /** Required: there is no ambient locale in this package. */
  locale: string;
  /** Used only when `value` is a bare minor-unit number. */
  currency: string;
  /** Passed through to @ultimat3/money: display, accounting, grouping. */
  options?: FormatMoneyOptions | undefined;
  /** Override for tests, custom rounding, or a non-Intl renderer. */
  format?: MoneyFormatter | undefined;
}

export function toMoney(value: MoneyInput, currency: string): Money {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw invalidValueError('Money', value, 'an integer number of minor units');
    }
    // Delegated so the currency code is validated by the one authority on it.
    return makeMoney(value, currency);
  }
  if (!Number.isInteger(value.minor)) {
    throw invalidValueError('Money', value, 'an integer number of minor units');
  }
  return value;
}

export function moneyText(view: MoneyViewOptions): string {
  const format = view.format ?? formatMoney;
  return format(toMoney(view.value, view.currency), view.locale, view.options);
}
