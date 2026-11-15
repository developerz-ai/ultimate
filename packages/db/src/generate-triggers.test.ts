// The lifecycle triggers as a migration plans them: installed once and recorded, a second generation
// over the recorded snapshot writes nothing, removing the declaration drops each trigger and `down`
// reinstalls it, and the record survives the snapshot sidecar's parse.

import { describe, expect, test } from 'bun:test';
import type { EntityDescriptionLike } from './entity-shape';
import { generateMigration } from './generate';
import { counterTriggerName } from './generate-counter';
import { HISTORY_GUARD_TRIGGER, HISTORY_TRIGGER } from './generate-history';
import { lifecycleEntities } from './lifecycle-live-fixture';
import { parseSnapshot } from './snapshot-parse';

const NOW = new Date('2026-11-06T00:00:00.000Z');
const gen = (
  entities: readonly EntityDescriptionLike[],
  current = generateMigration({ entities, name: 'a', now: NOW }).snapshot,
) => generateMigration({ entities, name: 'b', now: NOW, current });

describe('lifecycle triggers in a migration', () => {
  const entities = lifecycleEntities('unit');
  const [posts] = entities;
  const counter = posts?.counts?.[0];

  test('the first migration installs history, its guard and the counter, then recounts', () => {
    const first = generateMigration({ entities, name: 'a', now: NOW });
    const name = counter === undefined ? '' : counterTriggerName('unit_posts', counter);
    expect(first.up).toContain(
      `create trigger "${HISTORY_TRIGGER}" after insert or update or delete on "unit_posts"`,
    );
    expect(first.up).toContain(
      `create trigger "${HISTORY_GUARD_TRIGGER}" before update or delete on "unit_posts_history"`,
    );
    expect(first.up).toContain(
      `create trigger "${name}" after insert or delete or update of "post_id", "deleted_at" on "unit_likes"`,
    );
    expect(first.up).toContain('update "unit_posts" p set "like_count" =');
    const recorded = first.snapshot.tables.find((t) => t.name === 'unit_likes')?.triggers;
    expect(recorded?.map((t) => t.name)).toEqual([name]);
  });

  test('a second generation over the record writes nothing', () => {
    expect(gen(entities).up.trim()).toBe('');
  });

  test('a removed declaration drops its triggers, and down puts them back', () => {
    const bare = entities.map(({ history: _h, counts: _c, ...rest }) => rest);
    const removal = gen(bare, generateMigration({ entities, name: 'a', now: NOW }).snapshot);
    expect(removal.up).toContain(`drop trigger if exists "${HISTORY_TRIGGER}" on "unit_posts";`);
    expect(removal.up).toContain(
      `drop trigger if exists "${HISTORY_GUARD_TRIGGER}" on "unit_posts_history";`,
    );
    expect(removal.down).toContain(`create trigger "${HISTORY_TRIGGER}"`);
    expect(removal.snapshot.tables.some((t) => t.triggers !== undefined)).toBe(false);
  });

  test('the record survives the sidecar parse', () => {
    const { snapshot } = generateMigration({ entities, name: 'a', now: NOW });
    expect(parseSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  test('a changed where reinstalls and recounts on up; down reinstalls the old and recounts under it', () => {
    const withWhere = (sql: string) =>
      entities.map((entity) =>
        entity.counts === undefined
          ? entity
          : {
              ...entity,
              counts: entity.counts.map((each) => ({
                ...each,
                where: { sql, columns: ['org_id'] },
              })),
            },
      );
    const first = generateMigration({
      entities: withWhere('c."org_id" is not null'),
      name: 'a',
      now: NOW,
    });
    const change = gen(withWhere('c."org_id" is null'), first.snapshot);
    expect(change.up).toContain('and (c."org_id" is null))');
    expect(change.down).toContain(
      'exists (select from (select new.*) c where c."org_id" is not null)',
    );
    const reinstall = change.down.lastIndexOf('create trigger');
    const recount = change.down.indexOf('and (c."org_id" is not null))');
    expect(recount).toBeGreaterThan(reinstall);
    expect(change.down.slice(reinstall)).toContain("select set_config('x.cross', 'on', true);");
  });

  test('a record written before recount was recorded rolls back as it always did: no recount', () => {
    const first = generateMigration({ entities, name: 'a', now: NOW });
    const old = {
      ...first.snapshot,
      tables: first.snapshot.tables.map((table) => ({
        ...table,
        ...(table.triggers === undefined
          ? {}
          : { triggers: table.triggers.map(({ name, install }) => ({ name, install })) }),
      })),
    };
    const bare = entities.map(({ counts: _c, ...rest }) => rest);
    const removal = gen(bare, old);
    expect(removal.down).toContain('create trigger');
    expect(removal.down).not.toContain('update "unit_posts" p set');
  });

  test('a dropped counter reinstalled by down is recounted, from the recorded statement', () => {
    const bare = entities.map(({ counts: _c, ...rest }) => rest);
    const removal = gen(bare, generateMigration({ entities, name: 'a', now: NOW }).snapshot);
    expect(removal.down).toContain('update "unit_posts" p set "like_count" =');
  });
});
