// The route table and the fact tiles, pinned on fixed input.
import { expect, unitTest } from '@ultimat3/testing';
import { factsOf, formatCount, routeRows } from './dashboard-view';

unitTest('routeRows projects the three columns and sorts by path', () => {
  const rows = routeRows([
    { path: '/dashboard', surface: 'app', config: { render: 'ssr' } },
    { path: '/', surface: 'site', config: { render: 'static' } },
  ]);
  expect(rows.map((row) => row.path)).toEqual(['/', '/dashboard']);
  expect(rows[1]).toEqual({ path: '/dashboard', surface: 'app', render: 'ssr' });
});

unitTest('factsOf clamps counts and names an unknown version', () => {
  const facts = factsOf({ routes: -1, locales: 1, roles: 2, version: '' });
  expect(facts).toEqual({ routes: 0, locales: 1, roles: 2, version: 'unknown' });
  expect(factsOf({ routes: 3, locales: 1, roles: 2, version: '1.2.3' }).version).toBe('1.2.3');
});

unitTest('formatCount follows the locale', () => {
  expect(formatCount(1234, 'en')).toBe('1,234');
  expect(formatCount(1234, 'de')).toBe('1.234');
});
