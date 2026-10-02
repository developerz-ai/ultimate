// A row's RELATED rows: the `hasMany` relations a resource names in `related`, each read as the
// related resource's own list — its gate, its row scope, its columns — narrowed to the rows that
// point at this one. No second table is declared anywhere: the related resource already is one.

import { relationsFor as entityRelationsFor } from '@ultimat3/entity';
import { adminList, type CrudCtx, canOperate } from './crud';
import { AdminFieldUnsupportedError } from './errors';
import type { AdminPage } from './pagination';
import type { AdminFilter, AdminRow } from './registry';
import type { AdminResource } from './resource';

/** How many related rows a detail page shows per relation. The rest are one link away. */
export const RELATED_PAGE_SIZE = 10;

/** One declared relation, resolved against the admin it is declared in. */
export interface AdminRelated {
  /** The relation's name on the entity — what `related: [...]` spelled. */
  readonly name: string;
  /** The resource whose rows these are. */
  readonly resource: AdminResource;
  /** The property of THAT resource holding the foreign key. */
  readonly field: string;
  /** The property of the row in hand the foreign key points at. */
  readonly localKey: string;
}

/**
 * The `related` names of one resource, resolved. Every name is a `hasMany` of the entity whose
 * target is a resource of this admin — anything else is refused here, where it is declared, never
 * drawn as an empty card.
 */
export function relatedOf(
  resources: readonly AdminResource[],
  resource: AdminResource,
): readonly AdminRelated[] {
  if (resource.related.length === 0) return [];
  // The one read of `@ultimat3/entity`'s relations in this package: the FK already written IS
  // the relation, so the admin derives nothing of its own and names nothing twice.
  const relations = entityRelationsFor(resource.name);
  const offered = Object.values(relations)
    .filter((relation) => relation.kind === 'hasMany')
    .map((relation) => relation.name);
  const hint = `resources.${resource.name}.related may name: ${offered.length > 0 ? offered.join(', ') : 'nothing — no entity references this one'}`;

  return resource.related.map((name) => {
    const refuse = (cause: string, fix: string): never => {
      throw new AdminFieldUnsupportedError({ entity: resource.name, field: name, cause, fix });
    };
    const relation = Object.hasOwn(relations, name) ? relations[name] : undefined;
    if (relation === undefined) {
      return refuse('named in related and is not a relation of the entity', hint);
    }
    if (relation.kind !== 'hasMany') {
      return refuse(
        `named in related and is a belongsTo: the "${relation.localKey}" field already links to its row`,
        hint,
      );
    }
    const target = resources.find((known) => known.name === relation.to);
    if (target === undefined) {
      return refuse(
        `named in related, and its rows are "${relation.to}", which is not a resource of this admin`,
        `add the ${relation.to} entity to defineAdmin({ entities }) — its own list is what related draws`,
      );
    }
    return { name, resource: target, field: relation.remoteKey, localKey: relation.localKey };
  });
}

/** One related list as the detail page draws it. */
export interface AdminRelatedList {
  readonly related: AdminRelated;
  readonly page: AdminPage<AdminRow>;
  /** The one predicate that makes this list THIS row's. */
  readonly filter: AdminFilter;
}

/**
 * The related lists of one row — one statement each, read beside each other. A related resource
 * this actor may not list is LEFT OUT, silently: they asked for this row, and the refusal they
 * would get by opening that list is logged there. Everything else is `adminList`: the related
 * resource's policy decides, its `rows` narrows, and the read is audited under its own name.
 */
export async function relatedLists(
  related: readonly AdminRelated[],
  row: AdminRow,
  ctx: CrudCtx,
): Promise<readonly AdminRelatedList[]> {
  const readable = related.filter((one) => canOperate(one.resource, 'list', ctx));
  const read = await Promise.all(
    readable.map(async (one): Promise<AdminRelatedList | null> => {
      const key = row[one.localKey];
      if (key === null || key === undefined) return null;
      const filter: AdminFilter = { field: one.field, op: 'eq', value: String(key) };
      const result = await adminList<AdminRow>(one.resource, ctx, {
        // No scope, not even the default one: a related row counts whatever tab it sits under.
        scope: null,
        filters: [filter],
        limit: RELATED_PAGE_SIZE,
      });
      return result.ok ? { related: one, page: result.page, filter } : null;
    }),
  );
  return read.filter((one): one is AdminRelatedList => one !== null);
}
