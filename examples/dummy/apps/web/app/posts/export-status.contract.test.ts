/**
 * contract — an export's status read and its cancel, as its org sees them: `postsExportStatus` and
 * `cancelPostsExport` over `jobStatusFor`/`cancelJobFor`, under `postExport`. Another org's export
 * is answered as a missing one on both — no row, the same 404 — and is left running.
 */

import { contractTest, expect, test } from '@ultimat3/testing';
import { cancelPostsExport } from './actions/cancel-posts-export';
import { requestPostsExport } from './actions/request-posts-export';
import { exportPosts } from './jobs/export-posts';
import { postsExportStatus } from './queries/posts-export-status';

/** A job id of the right shape that nobody queued. */
const NO_SUCH_JOB = '019ff1c5-0000-7000-8000-00000000dead';

test('the org reads its own export: state and attempt, never the job’s input', async ({
  seed,
  actorFor,
  runJobs,
}) => {
  const { ada } = await seed('dev').pick({ ada: 'member:ada' });
  const started = await requestPostsExport.as(actorFor(ada), { orgId: ada.orgId });
  expect(await runJobs.depth(exportPosts)).toBe(1);

  const [status, ...rest] = await postsExportStatus.as(actorFor(ada), {
    orgId: ada.orgId,
    jobId: started.jobId,
  });
  expect(rest).toEqual([]);
  expect([status?.id, status?.name, status?.state, status?.attempt]).toEqual([
    started.jobId,
    'posts.export',
    'ready',
    0,
  ]);
  expect(status).not.toHaveProperty('input');
  expect(JSON.stringify(status)).not.toContain(started.exportId);
});

test('another org’s export reads as no export, and its org id is a denial', async ({
  seed,
  actorFor,
  runJobs,
}) => {
  const { ada, mara } = await seed('dev').pick({ ada: 'member:ada', mara: 'member:mara' });
  const started = await requestPostsExport.as(actorFor(ada), { orgId: ada.orgId });

  const foreign = await postsExportStatus.as(actorFor(mara), {
    orgId: mara.orgId,
    jobId: started.jobId,
  });
  const missing = await postsExportStatus.as(actorFor(mara), {
    orgId: mara.orgId,
    jobId: NO_SUCH_JOB,
  });
  expect(foreign).toEqual([]);
  expect(foreign).toEqual(missing);
  await expect(
    postsExportStatus.as(actorFor(mara), { orgId: ada.orgId, jobId: started.jobId }),
  ).rejects.toBeUltimateError('X_FORBIDDEN');
  expect(await runJobs.depth(exportPosts)).toBe(1);
});

test('the org cancels its own export, and the queue holds it no more', async ({
  seed,
  actorFor,
  runJobs,
}) => {
  const { ada } = await seed('dev').pick({ ada: 'member:ada' });
  const started = await requestPostsExport.as(actorFor(ada), { orgId: ada.orgId });

  const cancelled = await cancelPostsExport.as(actorFor(ada), {
    orgId: ada.orgId,
    jobId: started.jobId,
  });
  expect(cancelled).toEqual({ jobId: started.jobId, state: 'cancelled' });
  expect(await runJobs.depth(exportPosts)).toBe(0);
  const [status] = await postsExportStatus.as(actorFor(ada), {
    orgId: ada.orgId,
    jobId: started.jobId,
  });
  expect(status?.state).toBe('cancelled');
});

test('cancelling another org’s export is the 404 a missing one is, and it keeps running', async ({
  seed,
  actorFor,
  runJobs,
}) => {
  const { ada, mara } = await seed('dev').pick({ ada: 'member:ada', mara: 'member:mara' });
  const started = await requestPostsExport.as(actorFor(ada), { orgId: ada.orgId });

  await expect(
    cancelPostsExport.as(actorFor(mara), { orgId: mara.orgId, jobId: started.jobId }),
  ).rejects.toBeUltimateError('X_POSTS_EXPORT_NOT_FOUND');
  await expect(
    cancelPostsExport.as(actorFor(mara), { orgId: mara.orgId, jobId: NO_SUCH_JOB }),
  ).rejects.toBeUltimateError('X_POSTS_EXPORT_NOT_FOUND');
  expect(await runJobs.depth(exportPosts)).toBe(1);
});

test('an author without the export right may neither read nor cancel', async ({
  seed,
  actorFor,
}) => {
  const { ada, bruno } = await seed('dev').pick({ ada: 'member:ada', bruno: 'member:bruno' });
  const input = { orgId: ada.orgId, jobId: NO_SUCH_JOB };
  await expect(postsExportStatus.as(actorFor(bruno), input)).rejects.toBeUltimateError(
    'X_FORBIDDEN',
  );
  await expect(cancelPostsExport.as(actorFor(bruno), input)).rejects.toBeUltimateError(
    'X_FORBIDDEN',
  );
});

contractTest(
  'the status read and the cancel pass the contract each owes',
  async ({ seed, actorFor, runJobs }) => {
    // Generated uuids name no job, so the exercise is the miss path on both: an empty answer from
    // the read, the declared 404 from the cancel. `runJobs` installs the queue both ask.
    void runJobs;
    const { ada } = await seed('dev').pick({ ada: 'member:ada' });
    const exercise = {
      actor: actorFor(ada),
      input: (drawn: unknown) => ({ ...(drawn as object), orgId: ada.orgId }),
    };
    for (const contract of cancelPostsExport.contract({ exercise })) await contract.run();
    for (const contract of postsExportStatus.contract({ exercise })) await contract.run();
  },
);
