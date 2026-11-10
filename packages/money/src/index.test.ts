// The `.` barrel is the app API (v31): error factories, the code list and internal asserts stay
// in their modules. An app matches a refusal on `MoneyError` and its `code`.
import { expect, test } from 'bun:test';
import * as barrel from './index';

const INTERNAL = [
  'MONEY_ERROR_CODES',
  'MONEY_ERROR_TITLES',
  'allocationInvalid',
  'assertAllocationSums',
  'assertScale',
  'currencyDeclarationInvalid',
  'currencyMismatch',
  'currencyRedefined',
  'currencyRequired',
  'currencySymbol',
  'rateMissing',
  'rescaleNotExact',
  'scaleInvalid',
  'scaleNotWidening',
];

test('the barrel carries none of the internal names', () => {
  const names = Object.keys(barrel);
  expect(INTERNAL.filter((name) => names.includes(name))).toEqual([]);
});

test('it keeps the class an app matches on and the rate provider convertWith takes', () => {
  expect(typeof barrel.MoneyError).toBe('function');
  expect(typeof barrel.fixedRateProvider).toBe('function');
});
