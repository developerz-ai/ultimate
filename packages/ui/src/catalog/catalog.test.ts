// CATALOG.md is the page an agent reads instead of the source. A stale one is worse than none —
// so it is generated, and this test is what makes "generated" true: edit a prop, and the build
// fails until `bun run catalog` has run.

import { describe, expect, test } from 'bun:test';
import { buildCatalog, CATALOG_PATH, collectComponents } from './build-catalog';
import { CATALOG_BANNER } from './render-catalog';

describe('CATALOG.md', () => {
  test('matches what the current source renders', async () => {
    const committed = await Bun.file(CATALOG_PATH).text();
    expect(committed).toBe(await buildCatalog());
  });

  test('carries the generated banner, so nobody edits it by hand', async () => {
    const committed = await Bun.file(CATALOG_PATH).text();
    expect(committed.startsWith(CATALOG_BANNER)).toBe(true);
  });

  test('every component in src/components is present with a purpose line', async () => {
    const docs = await collectComponents();
    expect(docs.length).toBeGreaterThan(40);
    const undocumented = docs.filter((doc) => doc.summary === '').map((doc) => doc.name);
    expect(undocumented).toEqual([]);
  });

  test('every prop resolves to a named type — no empty cells', async () => {
    const broken = (await collectComponents()).flatMap((doc) =>
      doc.props.filter((prop) => prop.type === '').map((prop) => `${doc.name}.${prop.name}`),
    );
    expect(broken).toEqual([]);
  });

  test('union types are escaped so the markdown tables stay tables', async () => {
    const catalog = await buildCatalog();
    for (const line of catalog.split('\n')) {
      if (!line.startsWith('| `')) continue;
      // Four columns means five delimiters; an unescaped union pipe would add more.
      const unescaped = line.split(/(?<!\\)\|/).length - 1;
      expect([line, unescaped <= 5]).toEqual([line, true]);
    }
  });
});
