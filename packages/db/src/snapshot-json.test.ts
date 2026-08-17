// The proof is Biome itself, not a pinned string: `snapshotJson` claims to be a fixed point of the
// formatter every scaffolded app runs, and only the formatter can settle that. `x db gen` wrote
// `JSON.stringify(…, null, 2)` and every app's own `lint` step then rejected the file it had
// just written — the framework failing its own gate.

import { describe, expect, test } from 'bun:test';
import type { SchemaDescription } from './introspect';
import { snapshotJson } from './snapshot-json';

const column = (name: string, dataType = 'uuid') => ({
  name,
  dataType,
  nullable: false,
  default: null,
  position: 1,
});

const snapshot: SchemaDescription = {
  tables: [
    {
      schema: 'public',
      name: 'comments',
      columns: [column('id'), column('post_id'), column('body', 'text')],
      primaryKey: ['id'],
      indexes: [
        {
          name: 'comments_post_id_idx',
          columns: ['post_id'],
          unique: false,
          primary: false,
          where: null,
          order: null,
        },
      ],
      foreignKeys: [
        {
          name: 'comments_post_id_fkey',
          columns: ['post_id'],
          referencedTable: 'posts',
          referencedColumns: ['id'],
          onDelete: null,
        },
      ],
    },
    { schema: 'public', name: 'empty', columns: [], primaryKey: [], indexes: [], foreignKeys: [] },
  ],
};

/**
 * The scaffolded app's own config: `x new` writes `lineWidth: 100`, `indentWidth: 2`, spaces.
 * Written per run rather than shared, so this test cannot pass by reading the repo's own biome.json
 * — which excludes every `migrations` directory and would have passed the broken emitter too.
 */
const BIOME_CONFIG = `${JSON.stringify(
  {
    $schema: 'https://biomejs.dev/schemas/2.5.5/schema.json',
    files: { includes: ['**'] },
    formatter: { indentStyle: 'space', indentWidth: 2, lineWidth: 100 },
  },
  null,
  2,
)}\n`;

// `node:os`/`node:fs` — Bun ships no temp-directory locator or recursive remove of its own, and a
// scratch tree inside the checkout would be a formatter subject two concurrent suites share.
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The repo's own installed binary, never `bunx`: the scratch cwd has no `node_modules` to resolve. */
const BIOME = join(import.meta.dir, '..', '..', '..', 'node_modules', '.bin', 'biome');

/** `biome format` on the text, or the text unchanged. A difference is the failure. */
async function formatted(json: string): Promise<string> {
  const dir = join(tmpdir(), `ultimate-snapshot-json-${Bun.randomUUIDv7()}`);
  await Bun.write(join(dir, 'biome.json'), BIOME_CONFIG);
  await Bun.write(join(dir, 'subject.json'), json);
  const proc = Bun.spawn([BIOME, 'format', '--write', 'subject.json'], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  // A formatter that could not run would otherwise read as "no change" and pass every case here.
  if (code > 1) throw new Error(`biome did not run (${code}): ${stderr}`);
  const out = await Bun.file(join(dir, 'subject.json')).text();
  await rm(dir, { recursive: true, force: true });
  return out;
}

describe('unit · snapshotJson is what Biome would have printed', () => {
  test('the emitted snapshot is already formatted', async () => {
    const json = snapshotJson(snapshot);
    expect(await formatted(json)).toBe(json);
  });

  test('JSON.stringify(…, null, 2) is not — the emitter is doing real work', async () => {
    // The mutation this test catches: replacing `snapshotJson`'s body with `JSON.stringify`.
    const naive = `${JSON.stringify(snapshot, null, 2)}\n`;
    expect(await formatted(naive)).not.toBe(naive);
  });

  test('a string array that no longer fits on its line is broken, and stays broken', async () => {
    // The one rule with an arithmetic boundary: Biome counts the trailing comma, and the limit is
    // `<= 100`. A key list this long is a composite primary key on a wide table, not a hypothetical.
    const wide: SchemaDescription = {
      tables: [
        {
          schema: 'public',
          name: 'wide',
          columns: [],
          primaryKey: [
            'tenant_identifier',
            'aggregate_identifier',
            'sequence_number',
            'partition_key',
          ],
          indexes: [],
          foreignKeys: [],
        },
      ],
    };
    const json = snapshotJson(wide);
    expect(json).toContain('"primaryKey": [\n');
    expect(await formatted(json)).toBe(json);
  });

  test('the boundary is `<= 100` counting the comma, one character either side', async () => {
    // `      "primaryKey": [` is 20 characters, plus `["…"]` and the member's own comma: a key of
    // 75 lands the line on exactly 100 and stays inline, 76 makes it 101 and breaks. `< 100`,
    // `<` on 101, or forgetting the comma all move this by one and this test is where it shows.
    const keyed = (length: number): SchemaDescription => ({
      tables: [
        {
          schema: 'public',
          name: 'wide',
          columns: [],
          primaryKey: ['k'.repeat(length)],
          indexes: [],
          foreignKeys: [],
        },
      ],
    });
    const fits = snapshotJson(keyed(75));
    const over = snapshotJson(keyed(76));
    expect(fits).toContain(`"primaryKey": ["${'k'.repeat(75)}"],`);
    expect(over).toContain('"primaryKey": [\n');
    expect(await formatted(fits)).toBe(fits);
    expect(await formatted(over)).toBe(over);
  });

  test('round trips through the reader that applies it', async () => {
    const { parseSnapshot } = await import('./snapshot-parse');
    expect(parseSnapshot(JSON.parse(snapshotJson(snapshot)))).toEqual(snapshot);
  });

  test('ends in exactly one newline', () => {
    const json = snapshotJson(snapshot);
    expect(json.endsWith('}\n')).toBe(true);
    expect(json.endsWith('}\n\n')).toBe(false);
  });
});
