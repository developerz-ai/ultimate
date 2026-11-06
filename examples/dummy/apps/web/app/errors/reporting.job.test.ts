/**
 * job — Postly's error sink, against the app's store (in memory under `bun test`) and the real queue
 * the fixture installs. The facts worth failing on: one thrown fault reported by two requests is
 * ONE group counted twice — the row `/admin/errors` lists — and the issue job is enqueued once,
 * for the group's first sighting only.
 */

import { errorReport, InternalError } from '@ultimat3/core';
import { expect, jobTest } from '@ultimat3/testing';
import { openErrorIssue } from './jobs/open-error-issue';
import { errorGroups, errorSink } from './reporting';

/** The same fault on the same route, as two requests would each report it. */
const report = () =>
  errorReport(new InternalError({ cause: 'the feed read timed out', fix: 'x doctor --json' }), {
    source: 'http',
    scope: { operation: 'GET /feed' },
  });

jobTest('two requests that throw one fault are one group, and one issue', async ({ runJobs }) => {
  errorSink.report(report());
  errorSink.report(report());
  await errorSink.settled();

  const groups = await errorGroups.list({});
  const feed = groups.filter((group) => group.operation === 'GET /feed');
  expect(feed.map((group) => [group.code, group.count])).toEqual([['X_INTERNAL', 2]]);
  expect(await runJobs.depth(openErrorIssue)).toBe(1);

  const trace = await runJobs.drain();
  expect(trace.executions.map((run) => run.outcome)).toEqual(['completed']);
});
