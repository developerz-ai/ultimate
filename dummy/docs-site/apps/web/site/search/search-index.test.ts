import { expect, unitTest } from '@ultimat3/testing';
import { decodeIndex, encodeIndex } from './search-index';

const entry = {
  topic: '/errors/X_A',
  package: 'wiki',
  version: '',
  kind: 'guide',
  title: 'X_A: a',
  text: 'cause',
  symbols: ['X_A'],
  source: '/errors/X_A',
} as const;

unitTest('an index round-trips through its wire rows', () => {
  expect(decodeIndex(JSON.parse(encodeIndex([entry])))).toEqual([entry]);
  expect(JSON.parse(encodeIndex([entry]))).toEqual([['/errors/X_A', 'X_A: a', 'cause', ['X_A']]]);
});

unitTest('anything that is not an index decodes to undefined', () => {
  expect(decodeIndex({})).toBeUndefined();
  expect(decodeIndex([['a', 'b', 'c']])).toBeUndefined();
  expect(decodeIndex([['a', 'b', 'c', [1]]])).toBeUndefined();
});
