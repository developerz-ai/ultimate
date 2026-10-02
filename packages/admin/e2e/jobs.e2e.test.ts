// Over a real socket, as a browser drives it: the HTML a jobs screen renders is parsed for its
// forms, and what an operator would submit is posted back. A dead job retried from the BATCH BAR
// runs on the next worker pass; a queue paused from its screen stops being claimed. No browser:
// every control here is a native form, so a form post IS the click (`x verify`'s `e2e` step).
//
//   bun test packages/admin/e2e

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createContext, markListening, runWithContext } from '@ultimat3/core';
import { createWorker, resetJobDriver, type Worker } from '@ultimat3/jobs';
import { clearRoutes } from '@ultimat3/render';
import { MANAGER, type Seeded, seedQueue } from '../src/jobs/jobs-fixture';

const { renderComponent } = await import('@ultimat3/render/server');
const { defineAdmin } = await import('../src/admin');
const { adminRouteMatch } = await import('../src/routes');
const { staticAuthz } = await import('../src/authz');
const { clearAdminMounts } = await import('../src/mounts');

const admin = defineAdmin({
  basePath: '/e2e',
  entities: [],
  auth: { actor: () => ({ id: 'u-operator' }), authz: staticAuthz(MANAGER) },
});

/** A repeated name is a list, as a checkbox group posts it — the HTTP pipeline's own reading. */
function fields(body: string): Readonly<Record<string, unknown>> {
  const params = new URLSearchParams(body);
  return Object.fromEntries(
    [...new Set(params.keys())].map((key) => {
      const all = params.getAll(key);
      return [key, all.length === 1 ? all[0] : all];
    }),
  );
}

/** The host's half, and nothing more: match, answer, render — or the 303 a write earns. */
async function serve(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const matched = adminRouteMatch(admin, url.pathname);
  if (matched === null) return new Response('not found', { status: 404 });
  const post = request.method === 'POST';
  return runWithContext(createContext({ tz: 'UTC', locale: 'en' }), async () => {
    const answer = await matched.route.respond({
      ctx: await admin.requestCtx(request),
      params: matched.params,
      url: url.href,
      method: post ? 'POST' : 'GET',
      form: post ? fields(await request.text()) : null,
    });
    if (answer.kind === 'redirect') {
      return new Response(null, { status: 303, headers: { location: answer.location } });
    }
    const html = await renderComponent(() => answer.body, {}, 'apps/admin/app/admin/page.tsx');
    return new Response(html, { status: answer.status, headers: { 'content-type': 'text/html' } });
  });
}

const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: serve });
const unlisten = markListening(server.url.origin);
let seeded: Seeded;
let worker: Worker;

beforeAll(async () => {
  seeded = await seedQueue();
  worker = createWorker({
    driver: seeded.driver,
    workerId: 'e2e-worker',
    queues: ['default'],
    concurrency: 8,
    visibilityTimeoutMs: 60_000,
    heartbeatIntervalMs: 3_600_000,
    pollIntervalMs: 0,
    drainOnShutdown: false,
    context: () => createContext({ role: 'worker', buildId: 'e2e' }),
  });
});

afterAll(async () => {
  unlisten();
  await server.stop(true);
  resetJobDriver();
  // What `defineAdmin` registered process-wide: the next file in this process starts without it.
  clearRoutes();
  clearAdminMounts();
});

const page = async (path: string): Promise<string> => {
  const response = await fetch(new URL(path, server.url));
  expect({ path, status: response.status }).toEqual({ path, status: 200 });
  return response.text();
};

const post = (action: string, body: URLSearchParams): Promise<Response> =>
  fetch(new URL(action, server.url), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
  });

const attr = (tag: string, name: string): string | undefined =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]?.replaceAll('&amp;', '&');

/** The `<form>` whose markup carries `marker`, with its action and its hidden fields. */
function formWith(html: string, marker: string): { action: string; body: URLSearchParams } {
  const form = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)]
    .map((match) => match[0])
    .find((markup) => markup.includes(marker));
  if (form === undefined) return expect.unreachable(`no form on the page carries ${marker}`);
  const body = new URLSearchParams();
  for (const input of form.matchAll(/<input\b[^>]*>/g)) {
    const name = attr(input[0], 'name');
    if (attr(input[0], 'type') === 'hidden' && name !== undefined) {
      body.append(name, attr(input[0], 'value') ?? '');
    }
  }
  return { action: attr(form, 'action') ?? '', body };
}

describe('the jobs dashboard over a socket', () => {
  test('a dead job, checked and retried from the batch bar, runs on the next pass', async () => {
    const list = await page('/e2e/jobs/runs?scope=dead');
    const bar = formWith(list, 'id="x-admin-batch"');
    expect(list).toContain('<option value="job.retry"');
    // The row's checkbox joins the bar by its `form` attribute — what a click on it submits.
    const box = [...list.matchAll(/<input\b[^>]*form="x-admin-batch"[^>]*>/g)]
      .map((match) => match[0])
      .find((input) => attr(input, 'value') === seeded.ids.dead);
    if (box === undefined) return expect.unreachable('the dead row has no checkbox');
    bar.body.append(attr(box, 'name') ?? '', seeded.ids.dead);
    bar.body.set('name', 'job.retry');
    bar.body.set('selection', 'checked');

    const answer = await post(bar.action, bar.body);
    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain('<dd>1</dd>');
    expect((await seeded.operator.job(seeded.ids.dead))?.state).toBe('ready');

    const ran = await worker.tick();
    expect(ran.map((execution) => execution.jobId)).toContain(seeded.ids.dead);
    expect((await seeded.operator.job(seeded.ids.dead))?.state).toBe('done');
  });

  test('a queue paused from its screen stops being claimed, and resumes from it too', async () => {
    const detail = await page('/e2e/jobs/queues/default');
    const pause = formWith(detail, 'value="job.queue.pause"');
    const paused = await post(pause.action, pause.body);
    expect(paused.status).toBe(303);
    expect((await seeded.operator.pausedQueues()).map((queue) => queue.name)).toEqual(['default']);

    const { id } = await seeded.driver.enqueue({
      name: seeded.name,
      queue: 'default',
      input: { item: 'after-pause' },
      idempotencyKey: 'after-pause',
      maxAttempts: 1,
    });
    expect(await worker.tick()).toEqual([]);
    expect((await seeded.operator.job(id))?.state).toBe('ready');

    // The same screen now offers resume, and only resume.
    const after = await page('/e2e/jobs/queues/default');
    expect(after).not.toContain('value="job.queue.pause"');
    const resume = formWith(after, 'value="job.queue.resume"');
    expect((await post(resume.action, resume.body)).status).toBe(303);
    expect((await worker.tick()).map((execution) => execution.jobId)).toContain(id);
  });
});
