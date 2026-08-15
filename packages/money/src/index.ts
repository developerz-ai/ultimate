/** Public surface of @ultimat3/money. Explicit exports only. */

export {
  allocate,
  allocateByPercentages,
  allocateByRatios,
  assertAllocationSums,
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
  scaleOf,
} from './currency';
export {
  allocationInvalid,
  currencyMismatch,
  currencyRequired,
  currencyUnknown,
  decimalNotNumeric,
  decimalTooPrecise,
  MONEY_ERROR_CODES,
  MONEY_ERROR_TITLES,
  MoneyError,
  type MoneyErrorCode,
  moneyNotInteger,
  rateMissing,
  rescaleNotExact,
  scaleInvalid,
  scaleNotWidening,
} from './errors';
/** `ExchangeRate.ratio` is one of these; a provider with an exact rate writes the pair itself. */
export type { Fraction } from './factor';
export {
  currencySymbol,
  type FormatMoneyOptions,
  formatMoney,
  formatMoneyDecimal,
  formatMoneyParts,
} from './format';
export {
  currencyOf,
  equals,
  type FromDecimalOptions,
  formatMoneyDebug,
  fromDecimal,
  isMoney,
  type Money,
  money,
  toDecimalNumber,
  toDecimalString,
  zero,
} from './money';
export { rescale } from './rescale';
export {
  DEFAULT_ROUNDING,
  ROUNDING_MODES,
  type RoundingMode,
  roundToDigits,
  roundToInteger,
} from './rounding';
export { assertScale, commonScale, MAX_MONEY_SCALE, minorAt, moneyScale } from './scale';
