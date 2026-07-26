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
  MoneyError,
  type MoneyErrorCode,
  moneyNotInteger,
  rateMissing,
} from './errors';
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
export {
  DEFAULT_ROUNDING,
  ROUNDING_MODES,
  type RoundingMode,
  roundToDigits,
  roundToInteger,
} from './rounding';
