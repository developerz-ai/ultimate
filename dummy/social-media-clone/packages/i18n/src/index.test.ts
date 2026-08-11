import { expect } from 'bun:test';
import { unitTest } from '@ultimat3/testing';
import { catalogs } from './index';

unitTest('every locale has the same keys as the default one', () => {
  const base = Object.keys(catalogs.catalogs[catalogs.default]).sort();
  for (const locale of catalogs.locales) {
    expect(Object.keys(catalogs.catalogs[locale]).sort()).toEqual(base);
  }
});

unitTest('no catalog value is empty', () => {
  for (const catalog of Object.values(catalogs.catalogs)) {
    for (const value of Object.values(catalog)) expect(value.length).toBeGreaterThan(0);
  }
});
