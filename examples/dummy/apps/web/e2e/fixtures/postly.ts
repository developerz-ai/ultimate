/**
 * What the plan-101 acceptance suite needs of THIS app, on the framework's e2e driver
 * (`@ultimat3/cli`'s `startE2eApp`, `e2eBrowser`, `openE2eBrowser`): the seeded posts it names, the
 * demo sign-in cookie, a browser to drive, and the server's own answer about a like — read from a
 * rendered document or written over HTTP, never from a client store under test.
 */

import { expect } from 'bun:test';
import { seedId } from '@ultimat3/entity';
import type { E2eApp, E2eSession } from '@ultimat3/testing';
import { allowHost, findChrome, openE2eBrowser, startE2eApp } from '@ultimat3/testing';

/** A test's verdict, never a bare Error (`bun run scripts/test-bare-error.ts`). */
export const fail = (message: string): never => expect.unreachable(message);

/** The app root: `examples/dummy`, three directories above this file. */
export const APP_ROOT = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');

/** Skipped only when this machine has no Chrome; `E2E_BROWSER_REQUIRED=1` refuses the skip. */
export const noBrowser =
  (await findChrome(process.env)) === undefined && process.env['E2E_BROWSER_REQUIRED'] !== '1';

/** The demo sign-in (`app/auth/demo-actor.ts`): a cookie naming one of four seeded members. */
export const DEMO_MEMBER_COOKIE = 'postly_demo_member';
export type DemoMember = 'ada' | 'bruno' | 'kenji' | 'mara';

/** Seed labels this suite names — `packages/db/seeds/dev.ts` is where each is declared. */
export const POSTS = {
  tenancy: {
    id: seedId('post:tenancy'),
    orgId: seedId('org:acme'),
    title: 'Tenancy is a column, not a convention',
  },
  timezones: {
    id: seedId('post:timezones'),
    orgId: seedId('org:acme'),
    title: 'Nadie formatea una fecha sin zona',
  },
  offline: {
    id: seedId('post:offline'),
    orgId: seedId('org:tinta'),
    title: 'El feed funciona sin conexión',
  },
} as const;
export type PostLabel = keyof typeof POSTS;

/**
 * A freshly seeded app of its own, per describe: each case likes posts, and a like is not repeatable,
 * so no two cases may share a database. The gate's own app (`e2eBaseUrl()`) is left to the suites
 * that only read.
 */
export async function startPostly(mode: 'dev' | 'serve' = 'dev'): Promise<E2eApp> {
  const app = await startE2eApp({ root: APP_ROOT, mode });
  // The test preload seals `fetch`, and this app is another process, not a server this one booted:
  // its one origin is let through for this file's own reads and writes (`serverLikeCount`,
  // `likeOverHttp`) — per host, the way the seal intends, never unsealed wholesale.
  allowHost(new URL(app.base).host);
  return app;
}

export interface AcceptanceBrowser {
  readonly session: E2eSession;
  close(): void;
}

/**
 * A PRIVATE browser per suite, never the gate run's shared one. Two reasons, both measured: an init
 * script reaches every tab of a session, open or not, so a suite deleting `SharedWorker` would change
 * every later suite; and when the shared browser's DevTools connection dies (seen 2026-09-22: a
 * `Runtime.evaluate` in `offline-feed` stalled 30s and the connection closed), every suite still on
 * it failed with `the CDP connection is already closed` for a reason that was not its own.
 */
export async function acceptanceBrowser(initScript?: string): Promise<AcceptanceBrowser> {
  const own = await openE2eBrowser();
  if (initScript !== undefined) await own.session.addInitScript(initScript);
  return { session: own.session, close: () => own.close() };
}

export async function signInAs(
  session: E2eSession,
  app: E2eApp,
  member: DemoMember,
): Promise<void> {
  await session.setCookie(app.base, DEMO_MEMBER_COOKIE, member);
}

/**
 * What the SERVER says a post's like count is — `postById`'s own JSON, no client state and no
 * rendered words, so a member reading Spanish gets the same number as one reading English.
 */
export async function serverLikeCount(
  app: E2eApp,
  member: DemoMember,
  post: PostLabel,
): Promise<number> {
  const { id, orgId } = POSTS[post];
  const response = await fetch(`${app.base}/_x/query/post-by-id?orgId=${orgId}&postId=${id}`, {
    headers: { cookie: `${DEMO_MEMBER_COOKIE}=${member}` },
  });
  const body: unknown = await response.json();
  // Bare rows, or the record envelope when the query declares entity rows.
  const data = typeof body === 'object' && body !== null && 'data' in body ? body.data : body;
  const row: unknown = Array.isArray(data) ? data[0] : data;
  const count =
    typeof row === 'object' && row !== null && 'likeCount' in row ? row.likeCount : undefined;
  return typeof count === 'number'
    ? count
    : fail(`postById for ${post} answered ${String(response.status)} with no likeCount`);
}

/** A like written by ANOTHER principal straight over HTTP — a server change no tab caused. */
export async function likeOverHttp(
  app: E2eApp,
  member: DemoMember,
  post: PostLabel,
): Promise<void> {
  const response = await fetch(`${app.base}/api/posts/like`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: app.base,
      cookie: `${DEMO_MEMBER_COOKIE}=${member}`,
    },
    body: JSON.stringify({ postId: POSTS[post].id, orgId: POSTS[post].orgId }),
  });
  if (!response.ok) {
    fail(`likePost as ${member} answered ${String(response.status)}: ${await response.text()}`);
  }
}
