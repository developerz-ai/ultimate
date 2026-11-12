// The history trigger's arguments as `x db gen` writes them: the sealed columns ride as the seventh,
// and a column turning sealed (or unsealed) reinstalls the trigger over the recorded snapshot — the
// recorded install is the statements themselves, so a changed argument is a changed record.

import { describe, expect, test } from 'bun:test';
import type { EntityDescriptionLike } from './entity-shape';
import { generateMigration } from './generate';
import { HISTORY_FUNCTION, HISTORY_TRIGGER, historyTriggers } from './generate-history';
import { lifecycleEntities } from './lifecycle-live-fixture';

const NOW = new Date('2026-11-11T00:00:00.000Z');
const HISTORY = { table: 'notes_history', key: 'id', tenant: null, ignore: [] };

const recording = (history: typeof HISTORY & { readonly sealed?: readonly string[] }) => {
  const [parent] = historyTriggers('notes', history);
  return parent?.[1].install.at(-1) ?? expect.unreachable('the parent trigger is first');
};

describe('the history trigger leaves sealed columns out', () => {
  test('the sealed columns are the trigger’s seventh argument, empty when there are none', () => {
    expect(recording({ ...HISTORY, sealed: ['ssn', 'note'] })).toEndWith(
      `execute function "${HISTORY_FUNCTION}"('notes_history', 'id', '', '{}', '{}', '{}', '{"ssn","note"}');`,
    );
    expect(recording(HISTORY)).toEndWith(`'{}', '{}', '{}', '{}');`);
  });

  test('a column turning sealed reinstalls the trigger; the same declaration again writes nothing', () => {
    const entities = lifecycleEntities('seal');
    const before = generateMigration({ entities, name: 'a', now: NOW }).snapshot;
    const sealed = entities.map(
      (entity): EntityDescriptionLike =>
        entity.history === undefined
          ? entity
          : { ...entity, history: { ...entity.history, sealed: ['title'] } },
    );
    const change = generateMigration({ entities: sealed, name: 'b', now: NOW, current: before });
    expect(change.up).toContain(`drop trigger if exists "${HISTORY_TRIGGER}" on "seal_posts";`);
    expect(change.up).toContain(`'{"title"}');`);
    // `down` puts back what was recorded: the trigger with no sealed column named.
    expect(change.down).toContain(`create trigger "${HISTORY_TRIGGER}"`);
    expect(change.down).not.toContain(`'{"title"}'`);
    const again = generateMigration({
      entities: sealed,
      name: 'c',
      now: NOW,
      current: change.snapshot,
    });
    expect(again.up.trim()).toBe('');
  });
});
