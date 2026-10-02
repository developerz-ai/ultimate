// A resource read AS A TARGET: the label of each row another resource references, and the lookup
// a picker searches. Both are reads of the target — decided by its `list` gate, narrowed by its
// row scope, audited under its name — and both are batched: one statement per target resource per
// page, never one per row and never one per cell.

import { finiteCount } from '@ultimat3/core';
import type { AuditEntry } from './audit';
import type { AdminDecision } from './authz';
import { type CrudCtx, decideOperation } from './crud';
import { checkedFilter } from './list-filters';
import { rowWhere } from './list-scope';
import { type AdminPage, fetchPage } from './pagination';
import type { AdminRow } from './registry';
import { rowId } from './registry';
import { type AdminResource, repoOf } from './resource';

/** One row of a target, as a picker offers it and a reference cell shows it. */
export interface AdminOption {
  readonly id: string;
  readonly label: string;
}

/**
 * A target with at most this many visible rows is offered whole, as a `<select>`. One more and
 * the picker is a search: an option list nobody can scan is not a control.
 */
export const LOOKUP_SELECT_MAX = 50;

/** The most ids one label read names — the list's own page-size ceiling. */
const MAX_LABEL_IDS = 200;

/** The row's label-field value when it is text, else its id — never a blank cell. */
export function labelOf(
  row: AdminRow,
  resource: Pick<AdminResource, 'labelField' | 'idField'>,
): string {
  const value = row[resource.labelField];
  if (typeof value === 'string' && value !== '') return value;
  return rowId(row, resource.idField);
}

const optionOf = (resource: AdminResource, row: AdminRow): AdminOption => ({
  id: rowId(row, resource.idField),
  label: labelOf(row, resource),
});

const readEntry = (resource: AdminResource, ctx: CrudCtx, decision: AdminDecision) =>
  ctx.audit.append({
    requestId: ctx.requestId,
    actor: ctx.actor,
    operation: 'list',
    kind: 'operation',
    entity: resource.name,
    entityId: null,
    permission: decision.permission,
    outcome: 'allowed',
    reason: decision.reason,
  });

export interface AdminLookupRequest {
  /** Matched against the target's label, by its label filter's default operator. */
  readonly term?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export type AdminLookupResult =
  | {
      readonly ok: true;
      readonly options: readonly AdminOption[];
      readonly page: AdminPage<AdminRow>;
      readonly audit: AuditEntry;
    }
  | { readonly ok: false; readonly decision: AdminDecision };

/**
 * The one lookup of a target resource: `contains` on its label, keyset-paged in the resource's own
 * default order, behind the same `list` gate and the same row scope as its list screen. Every
 * filter and every input that references the resource asks this — an app writes no endpoint.
 */
export async function adminLookup(
  resource: AdminResource,
  ctx: CrudCtx,
  request: AdminLookupRequest = {},
): Promise<AdminLookupResult> {
  const decision = decideOperation(resource, 'list', ctx);
  if (!decision.allowed) return { ok: false, decision };
  const term = request.term?.trim() ?? '';
  const where = [
    ...rowWhere(resource, ctx.actor),
    // Through the validator, like any caller's filter: a label that takes no `contains` (an id)
    // is matched exactly, and one that is no filter at all is refused by name.
    ...(term === '' ? [] : [checkedFilter(resource, { field: resource.labelField, value: term })]),
  ];
  const page = await fetchPage(resource, {
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    // At least 1, and finite: a `NaN` here is a page that is never trimmed and never ends.
    limit: finiteCount('adminLookup', 'limit', request.limit ?? LOOKUP_SELECT_MAX, 1),
    ...(where.length === 0 ? {} : { where }),
  });
  return {
    ok: true,
    options: page.rows.map((row) => optionOf(resource, row)),
    page,
    audit: await readEntry(resource, ctx, decision),
  };
}

/** What one page needs of one target: the ids its cells show, and whether a control picks from it. */
export interface RelationNeed {
  readonly ids: ReadonlySet<string>;
  /** A filter or an input on the page picks a row of this target. */
  readonly pick: boolean;
}

export interface RelationData {
  /** id → label, for every id the page shows that this actor may see. */
  readonly labels: ReadonlyMap<string, string>;
  /**
   * Every row of the target, when there are at most `LOOKUP_SELECT_MAX` — the `<select>`. `null`
   * when there are more (the picker is the lookup screen) or when nothing on the page picks.
   */
  readonly options: readonly AdminOption[] | null;
}

const NOTHING: RelationData = { labels: new Map(), options: null };

async function relationOf(
  resource: AdminResource,
  ctx: CrudCtx,
  need: RelationNeed,
): Promise<RelationData> {
  if (!need.pick && need.ids.size === 0) return NOTHING;
  const decision = decideOperation(resource, 'list', ctx);
  // Not an event: the actor asked for another resource's page, and a label they may not read is
  // an id shown as an id. The refusal they would get by opening the target is logged there.
  if (!decision.allowed) return NOTHING;

  const repo = repoOf(resource);
  const visible = rowWhere(resource, ctx.actor);
  const labels = new Map<string, string>();
  let options: readonly AdminOption[] | null = null;
  let wanted = [...need.ids].slice(0, MAX_LABEL_IDS);

  if (need.pick) {
    // One over the ceiling: the extra row is how "small enough for a select" is learned without
    // a count, which on a large table is the slow query this probe exists to avoid.
    const rows = await repo.list({
      ...(visible.length === 0 ? {} : { where: visible }),
      sort: resource.defaultSort,
      limit: LOOKUP_SELECT_MAX + 1,
    });
    for (const row of rows) labels.set(rowId(row, resource.idField), labelOf(row, resource));
    if (rows.length <= LOOKUP_SELECT_MAX) {
      // The whole target is in hand, so every label the page needs is too: no second read.
      options = rows
        .map((row) => optionOf(resource, row))
        .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
      wanted = [];
    } else {
      wanted = wanted.filter((id) => !labels.has(id));
    }
  }

  if (wanted.length > 0) {
    const rows = await repo.list({
      where: [...visible, { field: resource.idField, op: 'in', value: wanted }],
      sort: resource.defaultSort,
      limit: wanted.length,
    });
    for (const row of rows) labels.set(rowId(row, resource.idField), labelOf(row, resource));
  }

  await readEntry(resource, ctx, decision);
  return { labels, options };
}

/**
 * Everything one page needs from the resources it references, keyed by target name. One statement
 * per target — two for a picked target too large for a `<select>` — whatever the page's row count
 * and however many columns point at the same target.
 */
export async function relationsFor(
  resources: readonly AdminResource[],
  ctx: CrudCtx,
  needs: ReadonlyMap<string, RelationNeed>,
): Promise<ReadonlyMap<string, RelationData>> {
  const targets = resources.filter((resource) => needs.has(resource.name));
  const read = await Promise.all(
    targets.map((resource) => relationOf(resource, ctx, needs.get(resource.name) ?? NO_NEED)),
  );
  return new Map(targets.map((resource, index) => [resource.name, read[index] ?? NOTHING]));
}

const NO_NEED: RelationNeed = { ids: new Set(), pick: false };

/**
 * What a set of rows and fields needs: per target resource, the ids the rows hold in the fields
 * that reference it, and whether any of `picked` — a filter, a form input — picks from it.
 */
export function relationNeeds(
  rows: readonly AdminRow[],
  shown: readonly { readonly name: string; readonly relation?: { readonly entity: string } }[],
  picked: readonly { readonly relation?: { readonly entity: string } }[],
): ReadonlyMap<string, RelationNeed> {
  const needs = new Map<string, { ids: Set<string>; pick: boolean }>();
  const need = (entity: string): { ids: Set<string>; pick: boolean } => {
    const held = needs.get(entity) ?? { ids: new Set<string>(), pick: false };
    needs.set(entity, held);
    return held;
  };
  for (const field of shown) {
    if (field.relation === undefined) continue;
    const held = need(field.relation.entity);
    for (const row of rows) {
      const value = row[field.name];
      if (value !== null && value !== undefined && value !== '') held.ids.add(String(value));
    }
  }
  for (const field of picked) {
    if (field.relation !== undefined) need(field.relation.entity).pick = true;
  }
  return needs;
}
