// The operator-surface scenarios a DASHBOARD needs beyond `x jobs`: a list and a bulk call scoped
// to one tenant, a page read backwards from a cursor, and "run now" over every matching row. Run
// on both drivers by the same two suites as `operator-surface-fixture.ts`.

import { expect, test } from 'bun:test';
import type { JobDriver } from './driver';
import { jobCursor } from './introspection';
import type { JobHandle } from './job';
import {
  enqueueItem,
  type ItemInput,
  itemJob,
  type OperatorHarness,
  operatorOf,
  rowOf,
} from './operator-surface-fixture';

async function enqueueFor(
  driver: JobDriver,
  handle: JobHandle<ItemInput>,
  tenantId: string,
  item: string,
  runAt?: number,
): Promise<string> {
  const { id } = await driver.enqueue({
    name: handle.name,
    queue: 'default',
    input: { item },
    idempotencyKey: `tenant:${tenantId}:${item}`,
    maxAttempts: 1,
    tenantId,
    ...(runAt === undefined ? {} : { runAt }),
  });
  return id;
}

export function operatorScopeScenarios(label: string, harness: OperatorHarness): void {
  test(`${label}: a list and a bulk call scoped to a tenant never reach another tenant's row`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const handle = itemJob({ run: () => Promise.resolve() });
    const ours = await enqueueFor(driver, handle, 'org-a', 'a1');
    await harness.elapse(driver, 1);
    const theirs = await enqueueFor(driver, handle, 'org-b', 'b1');

    const listed = await operator.list({ name: handle.name, tenantId: 'org-a' });
    expect(listed.map((row) => row.id)).toEqual([ours]);

    expect(
      await operator.removeMany({ state: 'ready', name: handle.name, tenantId: 'org-a' }),
    ).toEqual({ affected: 1, remaining: 0 });
    expect(await operator.job(ours)).toBeUndefined();
    expect((await rowOf(driver, theirs)).state).toBe('ready');
  });

  test(`${label}: a page read BEFORE a cursor is the rows just newer than it, newest first`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const handle = itemJob({ run: () => Promise.resolve() });
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push(await enqueueItem(driver, handle));
      await harness.elapse(driver, 1);
    }
    // Newest first: ids[4] … ids[0]. The page of two after the newest two is ids[2], ids[1].
    const second = await operator.list({
      name: handle.name,
      limit: 2,
      after: jobCursor(await rowOf(driver, ids[3] ?? '')),
    });
    expect(second.map((row) => row.id)).toEqual(ids.slice(1, 3).reverse());
    // Back from that page's first row: the two rows nearest it on the newer side, still newest
    // first — never the two newest in the table.
    const back = await operator.list({
      name: handle.name,
      limit: 2,
      before: jobCursor(await rowOf(driver, ids[1] ?? '')),
    });
    expect(back.map((row) => row.id)).toEqual(ids.slice(2, 4).reverse());
  });

  test(`${label}: promoteMany makes every matching row waiting on its clock due now`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const handle = itemJob({ run: () => Promise.resolve() });
    const now = (await rowOf(driver, await enqueueItem(driver, handle))).runAt;
    const later = [
      await enqueueFor(driver, handle, 'org-a', 'l1', now + 3_600_000),
      await enqueueFor(driver, handle, 'org-a', 'l2', now + 7_200_000),
    ];
    const elsewhere = await enqueueFor(driver, handle, 'org-b', 'l3', now + 3_600_000);

    expect(
      await operator.promoteMany({ state: 'delayed', name: handle.name, tenantId: 'org-a' }),
    ).toEqual({ affected: 2, remaining: 0 });
    for (const id of later) expect((await rowOf(driver, id)).state).toBe('ready');
    expect((await rowOf(driver, elsewhere)).state).toBe('delayed');
    // Only a row waiting on a clock: a state that is not ready or delayed is refused loudly.
    let refused: unknown;
    try {
      await operator.promoteMany({ state: 'dead' });
    } catch (error) {
      refused = error;
    }
    expect(String((refused as { code?: unknown } | undefined)?.code)).toBe('X_INVARIANT');
  });
}
