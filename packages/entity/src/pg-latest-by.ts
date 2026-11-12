// Single responsibility: the Postgres driver's `latestBy` — one statement per call (per 500 keys
// for a preload's parents), weighed and decoded as a page is. What the statement means is
// `latest-by.ts`'s; how it is spelled is `latest-by-sql.ts`'s. `pg-driver.ts` spreads this in.

import { type DbClient, withStatementAttribution } from '@ultimat3/db';
import { statementChunks } from './batch-read';
import type { EntityCore } from './entity';
import { assertGroupBound, type LatestBySpec, latestPlanOf, MAX_LATEST_GROUPS } from './latest-by';
import { distinctOnStatement, lateralStatement } from './latest-by-sql';
import { assertPageBytes } from './page-bytes';
import { decodeRow, type PhysicalRow } from './pg-row';
import type { FindManyArgs } from './repo';

export interface LatestByRead<Row> {
  latestBy(spec: LatestBySpec, args?: FindManyArgs): Promise<readonly Row[]>;
}

export const postgresLatestBy = <Row>(
  entity: EntityCore<Row>,
  client: () => DbClient,
): LatestByRead<Row> => ({
  async latestBy(spec, args = {}) {
    const op = 'latestBy';
    const shape = { includeDeleted: args.includeDeleted === true };
    const send = (statement: ReturnType<typeof distinctOnStatement>) =>
      withStatementAttribution(entity.$name, op, () => client().query<PhysicalRow>(statement));
    const keys = spec.keys;
    let found: readonly PhysicalRow[];
    if (keys === undefined) {
      const plan = latestPlanOf(entity, spec, args, op);
      found = await send(distinctOnStatement(entity, plan, shape, MAX_LATEST_GROUPS + 1));
      // One group per row here, so the row count IS the group count.
      assertGroupBound(entity, spec, found.length);
    } else {
      // Null is no parent (`preload.ts` drops it); an empty list sends nothing.
      const present = keys.filter((key) => key !== null && key !== undefined);
      // Judged even with nothing to send, so a refusal does not depend on the page being empty.
      if (present.length === 0) {
        latestPlanOf(entity, spec, args, op);
        return [];
      }
      // Planned per chunk: the plan's `in` carries the chunk's keys, never the whole list.
      const plans = statementChunks(present).map((chunk) => ({
        chunk,
        plan: latestPlanOf(entity, { ...spec, keys: chunk }, args, op),
      }));
      const pages: PhysicalRow[] = [];
      for (const { chunk, plan } of plans) {
        pages.push(...(await send(lateralStatement(entity, plan, shape, chunk, spec.perGroup))));
      }
      found = pages;
    }
    // Weighed raw, before a row is decoded, as `findMany` weighs its page.
    assertPageBytes(entity, op, found);
    return found.map((row) => decodeRow(entity, row));
  },
});
