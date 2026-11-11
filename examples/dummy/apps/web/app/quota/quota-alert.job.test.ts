/**
 * job — an org crossing its draft warning line, from the warning the meter queues to the row the
 * month-partitioned `quota_alerts` keeps and the text its owner receives, through the real queue.
 * What can fail: who is texted (owners with a phone, in their own locale), and that one crossing
 * is one row and one text however many times it runs.
 */

import { db } from '@postly/db';
import { orgId as toOrgId } from '@postly/domain';
import { ctxOf, runWithContext } from '@ultimat3/core';
import { memorySmsTransport } from '@ultimat3/notify';
import { installSmsTransport } from '@ultimat3/notify/adapter';
import { expect, jobTest } from '@ultimat3/testing';
import { postsQuotaWarning } from '../posts/jobs/posts-quota-warning';
import { alertsOf } from './repo';

jobTest(
  'a crossing is recorded once and texted once to the owner with a phone',
  async ({ seed, actorFor, runJobs }) => {
    const { ada, bruno } = await seed('dev').pick({ ada: 'member:ada', bruno: 'member:bruno' });
    // Bruno gives a phone too, and is an author: the alert is the plan's, so owners hear it alone.
    await runWithContext(ctxOf({ actor: actorFor(bruno) }), () =>
      db.members.update(bruno.id, { phone: '+34600123456' }, { orgId: bruno.orgId }),
    );
    const sms = memorySmsTransport();
    const release = installSmsTransport(sms);
    try {
      const warning = {
        action: 'createPost',
        meter: 'posts',
        orgId: ada.orgId,
        actorId: bruno.id,
        used: 80,
        limit: 100,
        periodStart: '2026-11-10T00:00:00.000Z',
        resetsAt: '2026-11-11T00:00:00.000Z',
      };
      // No `actor`: the production worker is nobody (`role-start.ts`).
      await runJobs(postsQuotaWarning, warning);
      await runJobs.drain();
      // The same warning again — a replay — writes no second row and sends no second text.
      await runJobs(postsQuotaWarning, warning);
      await runJobs.drain();

      // Ada is Acme's owner; Bruno, the author who crossed it, has a phone and is not texted.
      expect(sms.sent.map((message) => [message.to, message.body])).toEqual([
        [
          '+12025550142',
          'Postly: your org has used 80 of its 100 drafts for today. Upgrade the plan to write more.',
        ],
      ]);
      const rows = await runWithContext(ctxOf({ actor: actorFor(ada) }), () =>
        alertsOf(toOrgId(ada.orgId), 10),
      );
      expect(rows.map((row) => [row.meter, row.used, String(row.day)])).toEqual([
        ['posts', 80, '2026-11-10'],
      ]);
    } finally {
      release();
    }
  },
);
