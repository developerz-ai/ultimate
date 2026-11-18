// checkOutboundLinks's BODY, run by a worker in this process against the in-memory queue, over the
// real wiki with the network replaced: one step per link, and a dead link reaches the run's result.

import { afterEach, spyOn } from 'bun:test';
import { outboundLinks } from '@docs-site/docs-source';
import { expect, unitTest } from '@ultimat3/testing';
import { docsCorpus } from '../../../shared/docs';
import { checkOutboundLinks } from './check-outbound-links';

const network = spyOn(globalThis, 'fetch');
afterEach(() => network.mockReset());

unitTest(
  'every outbound link is probed once, and only the dead one is reported',
  async ({ runJobs }) => {
    const links = outboundLinks(await docsCorpus());
    const gone = links[0];
    expect(gone).toBeDefined();
    network.mockImplementation(
      (async (url: string | URL | Request) =>
        new Response(null, { status: String(url) === gone?.url ? 404 : 200 })) as typeof fetch,
    );

    const trace = await runJobs(checkOutboundLinks, {});

    expect(trace.executions.map((run) => run.outcome)).toEqual(['completed']);
    expect(network).toHaveBeenCalledTimes(links.length);
    expect(trace.steps[`probe:${gone?.url}`]?.executions).toBe(1);
    expect(trace.executions[0]?.result).toEqual({
      checked: links.length,
      dead: [{ url: gone?.url, status: 404, pages: gone?.pages }],
      unreachable: [],
    });
  },
);
