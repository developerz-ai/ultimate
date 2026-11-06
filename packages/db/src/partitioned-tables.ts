// Single responsibility: name the PARTITIONED parents in a schema (`relkind = 'p'`), so a table
// description can say it is one. The partitions themselves are not app schema and never reach
// here: `nonAppRelations()` excludes every `relispartition` row, a sub-partition's parent included.

import type { DbClient } from './client';
import { sql } from './sql';

interface PartitionedRow {
  readonly name: string;
}

/** The partitioned tables of `schema` that are not themselves a partition — the ones migrations declare. */
export async function partitionedTables(
  client: DbClient,
  schema: string,
): Promise<readonly string[]> {
  const rows = await client.query<PartitionedRow>(sql`
    select c.relname as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and c.relkind = 'p' and not c.relispartition
  `);
  return rows.map((row) => row.name);
}
