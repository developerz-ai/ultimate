/** Public surface of @ultimat3/money. Explicit exports only. */

export {
  allocate,
  allocateByPercentages,
  allocateByRatios,
  MAX_ALLOCATION_PARTS,
} from './allocate';
export {
  absolute,
  add,
  assertSameCurrency,
  compare,
  divide,
  greaterThan,
  isNegative,
  isPositive,
  isZero,
  lessThan,
  max,
  min,
  multiply,
  negate,
  subtract,
  sum,
} from './arithmetic';
export {
  type ConvertedMoney,
  type ConvertOptions,
  convert,
  convertWith,
  type ExchangeRate,
  fixedRateProvider,
  type RateProvider,
} from './convert';
export {
  assertCurrency,
  CURRENCIES,
  type CurrencyCode,
  type CurrencyInfo,
  currencyCodes,
  currencyInfo,
  exponentOf,
  isValidCurrency,
  registerCurrency,
  scaleOf,
} from './currency';
export {
  currencyUnknown,
  decimalNotNumeric,
  decimalTooPrecise,
  MoneyError,
  type MoneyErrorCode,
  moneyNotInteger,
  rateUnusable,
} from './errors';
/** `ExchangeRate.ratio` is one of these; a provider with an exact rate writes the pair itself. */
export type { Fraction } from './factor';
export {
  type FormatMoneyOptions,
  formatMoney,
  formatMoneyDecimal,
  formatMoneyParts,
  MAX_FRACTION_DIGITS,
} from './format';
export {
  currencyOf,
  equals,
  type FromDecimalOptions,
  formatMoneyDebug,
  fromDecimal,
  fromMinor,
  isMoney,
  type Money,
  toDecimalNumber,
  toDecimalString,
  zero,
} from './money';
export { type ParseAmountOptions, parseAmount } from './parse-input';
export { rescale } from './rescale';
export {
  DEFAULT_ROUNDING,
  ROUNDING_MODES,
  type RoundingMode,
  roundToDigits,
  roundToInteger,
} from './rounding';
export { commonScale, minorAt, moneyScale } from './scale';
