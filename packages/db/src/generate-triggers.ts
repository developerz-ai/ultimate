// Single responsibility: an entity's lifecycle triggers — history, its guard, counters — as one
// list per table, planned in both directions against what the newest snapshot recorded, and written
// onto the snapshot so each is a one-time statement. The SQL of each is its own file's.

import type { EntityDescriptionLike } from './entity-shape';
import type { Plan } from './foreign-key-plan';
import { counterTrigger, recountSql } from './generate-counter';
import { historyTriggers } from './generate-history';
import type { SchemaDescription, TableDescription, TriggerRecord } from './introspect';
import { findTable } from './introspect';
import { CROSS_TENANT_SETTING } from './row-security';
import { identifier } from './sql';

/** Every declared lifecycle trigger, by the table it sits on, in declaration order. */
export function declaredTriggers(
  entities: readonly EntityDescriptionLike[],
): ReadonlyMap<string, readonly TriggerRecord[]> {
  const byTable = new Map<string, TriggerRecord[]>();
  const add = (table: string, trigger: TriggerRecord): void => {
    const list = byTable.get(table) ?? [];
    list.push(trigger);
    byTable.set(table, list);
  };
  for (const entity of entities) {
    if (entity.history !== undefined) {
      for (const [table, trigger] of historyTriggers(entity.table, entity.history)) {
        add(table, trigger);
      }
    }
    for (const counter of entity.counts ?? [])
      add(counter.table, counterTrigger(entity.table, counter));
  }
  return byTable;
}

const dropSql = (table: string, name: string): string =>
  `drop trigger if exists ${identifier(name).text} on ${identifier(table).text};`;

const same = (left: TriggerRecord, right: TriggerRecord): boolean =>
  left.install.join('\n') === right.install.join('\n');

/**
 * The recount a NEW counter starts with, so a table that already holds rows is true from the first
 * write. Cross-tenant for the one statement: under forced row security an unset tenant matches no
 * row, and the recount would update nothing in silence.
 */
function recounts(
  entities: readonly EntityDescriptionLike[],
  added: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const entity of entities) {
    for (const counter of entity.counts ?? []) {
      const trigger = counterTrigger(entity.table, counter);
      if (!added.has(`${counter.table}.${trigger.name}`)) continue;
      out.push(`select set_config('${CROSS_TENANT_SETTING}', 'on', true);`);
      out.push(recountSql(entity.table, counter));
    }
  }
  return out;
}

/**
 * Both directions, after every table exists. Declared and not recorded (or recorded with other
 * statements): install, and `down` drops it — or reinstalls what was recorded. Recorded and no
 * longer declared: drop, and `down` reinstalls it. A table dropped outright needs nothing: its
 * triggers go with it. Functions are never dropped: one with no trigger does nothing.
 */
export function triggerPlan(
  plan: Plan,
  entities: readonly EntityDescriptionLike[],
  current: SchemaDescription,
): void {
  const declared = declaredTriggers(entities);
  const tables = new Set(entities.map((entity) => entity.table));
  const added = new Set<string>();
  for (const [table, triggers] of declared) {
    const recorded = findTable(current, table)?.triggers ?? [];
    for (const trigger of triggers) {
      const before = recorded.find((each) => each.name === trigger.name);
      if (before !== undefined && same(before, trigger)) continue;
      plan.up.push(...trigger.install);
      // `down` is reversed whole: pushed in apply order, reversed back into it.
      if (before === undefined) plan.down.push(dropSql(table, trigger.name));
      else plan.down.push(...[...before.install].reverse());
      added.add(`${table}.${trigger.name}`);
    }
  }
  for (const table of current.tables) {
    if (!tables.has(table.name)) continue;
    const wanted = declared.get(table.name) ?? [];
    for (const recorded of table.triggers ?? []) {
      if (wanted.some((each) => each.name === recorded.name)) continue;
      plan.up.push(dropSql(table.name, recorded.name));
      plan.down.push(...[...recorded.install].reverse());
    }
  }
  plan.up.push(...recounts(entities, added));
}

/** The snapshot, each table carrying the triggers declared on it — absent where there are none. */
export function recordTriggers(
  snapshot: SchemaDescription,
  entities: readonly EntityDescriptionLike[],
): SchemaDescription {
  const declared = declaredTriggers(entities);
  const retained = new Set(
    entities.filter((entity) => entity.retain !== undefined).map((entity) => entity.table),
  );
  const tables = snapshot.tables.map((table): TableDescription => {
    const triggers = declared.get(table.name);
    return {
      ...table,
      ...(triggers === undefined ? {} : { triggers }),
      ...(retained.has(table.name) ? { retain: true as const } : {}),
    };
  });
  return { ...snapshot, tables };
}
