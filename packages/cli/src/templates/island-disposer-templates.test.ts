// Every island a generator writes passes the rule the `boundaries` step holds an app to: its
// `mount` returns Solid's disposer. Two templates emitted `mount(): void`, so every generated app
// leaked its theme toggle and its forms across client-router navigations.

import { expect, test } from 'bun:test';
import { islandDisposerFindings } from '../island-disposer';
import { islandFiles } from './island';
import { names } from './naming';
import { formIslandFiles } from './resource-form-island';
import { shellFiles } from './scaffold-shell';

const emitted = [
  ...islandFiles('counter', { dir: 'apps/web/app/counter' }),
  ...formIslandFiles(names('invoice'), 'apps/web/app/invoice', 'apps/web/app/invoices'),
  ...shellFiles(names('acme'), true),
  ...shellFiles(names('acme'), false),
].map((file) => ({ path: file.path, source: String(file.contents) }));

test('each generator emits at least one island, so the check below reads something', () => {
  const islands = emitted.filter((file) => file.path.endsWith('.island.tsx'));
  expect(islands.length).toBeGreaterThanOrEqual(4);
});

test('no emitted island mount is X_ISLAND_DISPOSER_MISSING', () => {
  expect(islandDisposerFindings(emitted).map((finding) => finding.cause)).toEqual([]);
});
