// checkOutboundLinks: the nightly check of what the static build cannot prove, that the external
// pages the manual links to still exist. `cronJob()` is a factory over job() and task(), so
// `checkOutboundLinks.schedule` is a task like any other. It reads `wiki/`, so it runs from a
// checkout of this repository, and a dead link is a warning: another site's outage breaks no build.

import { outboundLinks } from '@docs-site/docs-source';
import { cronJob } from '@ultimat3/jobs';
import { docsCorpus } from '../../../shared/docs';
import { probeLink } from '../probe-link';

export const checkOutboundLinks = cronJob({
  // Pinned: the scheduler keys `.schedule`'s last firing by this name, the queue its rows.
  name: 'check-outbound-links',
  cron: '0 3 * * *',
  // REQUIRED IANA zone: "server time" is not a timezone.
  tz: 'UTC',
  // The manual belongs to no org, and this reads no table.
  tenant: 'none',
  retry: { attempts: 3, backoff: 'exponential' },
  // A few hundred sequential requests, each under its own ten-second deadline.
  timeout: '1h',
  async run({ step, ctx }) {
    const links = await step.run('collect', async () => outboundLinks(await docsCorpus()));
    const dead: { url: string; status: number | null; pages: readonly string[] }[] = [];
    const unreachable: string[] = [];
    // One step per link: a retry replays the answers it has and asks only for the rest.
    for (const { url, pages } of links) {
      const probe = await step.run(`probe:${url}`, () => probeLink(url));
      if (probe.verdict === 'dead') dead.push({ url, status: probe.status, pages });
      if (probe.verdict === 'unreachable') unreachable.push(url);
    }
    if (dead.length > 0) ctx.logger.warn('docs.outbound.dead', { dead });
    return { checked: links.length, dead, unreachable };
  },
});
