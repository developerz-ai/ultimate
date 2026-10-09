/**
 * job — `purgeMcpConfirmations`, through the real queue the fixture installs, against the app's
 * confirmation store (in memory under `bun test`). The fact worth failing on is the retention line:
 * a row past it goes, a row inside it stays — a sweep that deleted on expiry alone would erase who
 * approved a publish the moment the approval window closed.
 */

import { confirmationStore } from '@postly/mcp/confirmations';
import { expect, jobTest } from '@ultimat3/testing';
import { CONFIRMATION_RETENTION_MS, purgeMcpConfirmations } from './jobs/purge-mcp-confirmations';

const DAY_MS = 24 * 60 * 60 * 1000;

/** One pending row that expired `daysAgo` days before `now` — the test clock's, which the job reads. */
const openExpired = async (now: Date, id: string, daysAgo: number): Promise<void> => {
  const expiresAt = new Date(now.getTime() - daysAgo * DAY_MS);
  await confirmationStore.open({
    id,
    actorId: '00000000-0000-4000-8000-0000000000a1',
    orgId: '00000000-0000-4000-8000-0000000000aa',
    tool: 'publishPost',
    inputDigest: `h1:test:${id}`,
    sealedArguments: 'sealed',
    createdAt: new Date(expiresAt.getTime() - 600_000),
    expiresAt,
  });
};

jobTest(
  'the purge keeps a month of confirmations and deletes what is older',
  async ({ runJobs, clock }) => {
    const old = '00000000-0000-4000-8000-00000000c0d1';
    const recent = '00000000-0000-4000-8000-00000000c0d2';
    await openExpired(clock.now(), old, CONFIRMATION_RETENTION_MS / DAY_MS + 1);
    await openExpired(clock.now(), recent, 1);

    const trace = await runJobs(purgeMcpConfirmations, {});

    expect(trace.executions.map((run) => [run.outcome, run.error])).toEqual([
      ['completed', undefined],
    ]);
    expect(await confirmationStore.get(old)).toBeUndefined();
    expect(await confirmationStore.get(recent)).toBeDefined();
  },
);
