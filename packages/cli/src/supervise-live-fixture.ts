// One entry point run twice over, as a container's is: started by the test it SUPERVISES (the
// real `supervise()` and `startSupervisorProbe()`); started by the supervisor (`ULTIMATE_CHILD`) it
// SERVES — `PORT` with the core seam's `reusePort`, a loopback scrape, the real child link.
// Answers `<index> <pid>`, so the test can tell children apart and kill one.

import { sharedPortOption, supervisedChild } from '@ultimat3/core';
import { supervise } from './supervise';
import { linkToSupervisor } from './supervise-child';
import { childHealthy, startSupervisorProbe } from './supervise-probe';

const env = process.env;
const place = supervisedChild(env);

if (place === undefined) {
  let view: ReturnType<typeof supervise>['view'] | undefined;
  const probe = startSupervisorProbe({
    port: Number(env['METRICS_PORT']),
    hostname: '127.0.0.1',
    role: 'web',
    view: {
      children: () => view?.children() ?? [],
      ready: () => view?.ready() ?? false,
      live: () => view?.live() ?? true,
    },
  });
  const supervisor = supervise({
    count: Number(env['FIXTURE_COUNT'] ?? '2'),
    role: 'web',
    env,
    pool: 4,
    budgetMs: 3_000,
    healthy: childHealthy,
  });
  view = supervisor.view;
  const code = await supervisor.done;
  probe.stop();
  process.exit(code);
} else {
  const link = linkToSupervisor(env);
  const server = Bun.serve({
    port: Number(env['PORT']),
    hostname: '127.0.0.1',
    ...sharedPortOption(env),
    fetch: () => new Response(`${String(place.index)} ${String(process.pid)}`),
  });
  const scrape = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) =>
      new URL(request.url).pathname === '/metrics'
        ? new Response(`fixture_up 1\n`)
        : new Response('ok'),
  });
  const leave = async (): Promise<void> => {
    await server.stop();
    scrape.stop(true);
    link?.gone(0);
    process.exit(0);
  };
  process.on('SIGTERM', () => void leave());
  process.on('SIGINT', () => void leave());
  link?.ready(scrape.url.origin);
}
