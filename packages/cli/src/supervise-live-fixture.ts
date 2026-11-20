// One entry point run twice over, as a container's is: started by the test it SUPERVISES (the
// real `supervise()` and `startSupervisorProbe()`); started by the supervisor (`ULTIMATE_CHILD`) it
// SERVES — `PORT` with the core seam's `reusePort`, a loopback scrape, the real child link.
// Answers `<index> <pid>`, so the test can tell children apart and kill one.

import type { SupervisedChild } from '@ultimat3/core';
import { sharedPortOption, supervisedChild } from '@ultimat3/core';
import { supervise } from './supervise';
import { linkToSupervisor } from './supervise-child';
import { childHealthy, startSupervisorProbe } from './supervise-probe';

type Env = Readonly<Record<string, string | undefined>>;

/** The supervisor's half: the container's probe, then `FIXTURE_COUNT` children; its exit code. */
export async function superviseFixture(env: Env): Promise<number> {
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
  return code;
}

/** A child's half: serve `PORT`, a loopback scrape, say ready. `leave` is what a signal runs. */
export function serveFixtureChild(
  env: Env,
  place: SupervisedChild,
): { readonly url: string; leave(): Promise<void> } {
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
  link?.ready(scrape.url.origin);
  return {
    url: server.url.origin,
    async leave(): Promise<void> {
      await server.stop();
      scrape.stop(true);
      link?.gone(0);
      link?.release();
    },
  };
}

if (import.meta.main) {
  const env = process.env;
  const place = supervisedChild(env);
  if (place === undefined) process.exit(await superviseFixture(env));
  else {
    const child = serveFixtureChild(env, place);
    const leave = (): void => {
      void child.leave().then(() => process.exit(0));
    };
    process.on('SIGTERM', leave);
    process.on('SIGINT', leave);
  }
}
