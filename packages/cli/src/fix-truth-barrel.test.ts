// FX1 of `fix-truth.test.ts`, over a scaffold of its own: an island reading a repository, refused
// at the island, and the printed edits followed until `boundaries` is green and the tree compiles.
// The costliest row (two compiles and a barrel walk) — a file of its own so it runs beside the rest.

import { afterAll, beforeAll, describe, test } from 'bun:test';
import { type FixtureApp, fixtureApp } from './fix-truth-fixture';
import { fixTruthRows, ROW_MS } from './fix-truth-rows-fixture';

let app: FixtureApp;

beforeAll(async () => {
  app = await fixtureApp();
}, ROW_MS);

afterAll(() => app.remove());

const rows = fixTruthRows(() => app);

describe('a printed fix, executed', () => {
  test.each(rows.barrel.map((row) => [row.name, row] as const))(
    '%s',
    (_name, row) => rows.run(row),
    ROW_MS,
  );
});
