// A monthly budget, as a sales enquiry carries it: read from the text a person typed in their own
// locale (`@ultimat3/money`'s `parseAmount`, refused rather than rounded) and written back in the
// reader's. Postly never holds a typed amount as a float or as the string it arrived as.

import { formatMoney, type Money, parseAmount } from '@ultimat3/money';
import type { BillingCurrency } from './plans';
import type { AppLocale } from './preferences';

/** `X_MONEY_INPUT_INVALID` (422) when the text is unreadable or too precise in that locale. */
export const typedBudget = (text: string, currency: BillingCurrency, locale: AppLocale): Money =>
  parseAmount(text, { currency, locale });

/** The budget as a reader of `locale` writes it: its separators, its symbol placement. */
export const budgetText = (amount: Money, locale: string): string => formatMoney(amount, locale);
