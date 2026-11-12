// A text `contains` in a red statement: `ilike` as sent, `~~*` as a plan prints it. Only a
// `gin_trgm_ops` index serves it — a btree on the same column does not — so the finding names that
// declaration (`@ultimat3/entity`'s spelling) and only a declared trigram index argues it away.

import type { SeedEntity } from './seed-graph-shape';

const escaped = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `"title" ilike $1`, `title ~~* $1`, `p.title ILIKE …`: the column, then the operator. */
const searches = (statement: string, column: string): boolean =>
  new RegExp(`(?:^|[\\s(.,])"?${escaped(column)}"?\\s+(?:ilike|~~\\*)\\s`, 'i').test(statement);

/** The physical columns among `range` the statement compares with `ilike`. */
export const trigramColumns = (statement: string, range: readonly string[]): readonly string[] =>
  range.filter((column) => searches(statement, column));

/** A declared `gin_trgm_ops` index leading with this physical column, total or partial. */
export const trigramServed = (entity: SeedEntity, column: string): boolean =>
  entity
    .$describe()
    .indexes.some((index) => index.operatorClass === 'gin_trgm_ops' && index.columns[0] === column);
