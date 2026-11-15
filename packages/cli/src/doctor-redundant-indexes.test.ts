// `x doctor`'s redundant-index listing: the covered implicit indexes still in the newest snapshot,
// one line each and the `x db gen --drop-redundant` that drops them. A listing, never a finding.

import { describe, expect, test } from 'bun:test';
import type { SchemaDescription } from '@ultimat3/db';
import type { RegistryEntry } from '@ultimat3/entity';
import { redundantIndexesProbe, withRedundantIndexes } from './doctor-redundant-indexes';
import type { CommandResult } from './output';

const verdict: CommandResult = {
  ok: true,
  command: 'doctor',
  summary: 's',
  findings: [],
  data: {},
};

const entry = (table: string, covered: readonly string[]): RegistryEntry =>
  ({
    name: table,
    tableName: table,
    coveredIndexes: covered.map((name) => ({
      name,
      columns: ['tag_id'],
      coveredBy: `${table}_pkey`,
    })),
    describe: () => ({ name: table, table, primaryKey: [], columns: [], indexes: [] }),
    references: () => [],
  }) as unknown as RegistryEntry;

const snapshot = (tables: Record<string, readonly string[]>): SchemaDescription => ({
  tables: Object.entries(tables).map(([name, indexes]) => ({
    schema: 'public',
    name,
    columns: [],
    primaryKey: [],
    indexes: indexes.map((index) => ({
      name: index,
      columns: ['tag_id'],
      unique: false,
      primary: false,
      where: null,
      order: null,
    })),
    foreignKeys: [],
  })),
});

describe('x doctor · redundant indexes', () => {
  test('lists each covered index the snapshot still holds; the verdict is untouched', async () => {
    const probe = await redundantIndexesProbe('/app', async () => ({
      entries: [entry('links', ['links_tag_id_idx']), entry('fresh', ['fresh_tag_id_idx'])],
      // `fresh` has no migration yet; `gone` was dropped already.
      current: snapshot({ links: ['links_tag_id_idx'], gone: [] }),
    }));
    expect(probe?.map((each) => each.name)).toEqual(['links_tag_id_idx']);
    const shown = withRedundantIndexes(verdict, probe);
    expect(shown.ok).toBe(true);
    expect(shown.findings).toEqual([]);
    const text = (shown.lines ?? []).join('\n');
    expect(text).toContain('links.links_tag_id_idx');
    expect(text).toContain('links_pkey');
    expect(text).toContain('x db gen "drop redundant indexes" --drop-redundant');
    expect(shown.data).toMatchObject({
      redundantIndexes: [{ table: 'links', name: 'links_tag_id_idx', coveredBy: 'links_pkey' }],
    });
  });

  test('none, or an app that would not load: silent', async () => {
    const none = await redundantIndexesProbe('/app', async () => ({
      entries: [entry('links', ['links_tag_id_idx'])],
      current: snapshot({ links: [] }),
    }));
    expect(none).toEqual([]);
    expect(withRedundantIndexes(verdict, none).lines).toBeUndefined();
    expect(await redundantIndexesProbe('/app', async () => undefined)).toBeUndefined();
    expect(withRedundantIndexes(verdict, undefined)).toBe(verdict);
  });
});
