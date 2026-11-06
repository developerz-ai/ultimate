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
});
