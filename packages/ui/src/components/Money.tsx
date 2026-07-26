// Formats through @ultimat3/money using the locale and currency from context —
// never a process-wide default, never a float, never a hardcoded symbol.

import type { FormatMoneyOptions, Money as MoneyValue } from '@ultimat3/money';
import type { JSX } from 'solid-js';
import { cx } from '../cx';
import { useUi } from '../theme/context';
import styles from './Money.module.scss';
import { type MoneyFormatter, moneyText } from './money-view';

export interface MoneyProps {
  /** A Money value, or bare minor units in the context currency. */
  value: MoneyValue | number;
  /** Overrides the context currency for bare-number values. */
  currency?: string | undefined;
  /** Overrides the context locale. Use only for side-by-side comparisons. */
  locale?: string | undefined;
  /** Colour negatives with the danger role, e.g. in a ledger. */
  signed?: boolean | undefined;
  /** Passed to @ultimat3/money: display, accounting, grouping, fractionDigits. */
  options?: FormatMoneyOptions | undefined;
  format?: MoneyFormatter | undefined;
  class?: string | undefined;
}

export function Money(props: MoneyProps): JSX.Element {
  const ui = useUi();
  const minor = (): number => (typeof props.value === 'number' ? props.value : props.value.minor);
  const text = (): string =>
    moneyText({
      value: props.value,
      locale: props.locale ?? ui.locale,
      currency: props.currency ?? ui.currency,
      ...(props.options === undefined ? {} : { options: props.options }),
      ...(props.format === undefined ? {} : { format: props.format }),
    });

  return (
    <span
      class={cx(
        styles['money'],
        props.signed === true && minor() < 0 && styles['negative'],
        props.class,
      )}
    >
      {text()}
    </span>
  );
}
