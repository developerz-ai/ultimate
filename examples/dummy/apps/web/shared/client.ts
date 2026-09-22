/**
 * The two typed clients — `client` writes, `queries` reads. `Api` is imported **as a type only**,
 * so no module-graph edge exists from a page to a feature's implementation — which is what keeps
 * `site/` at 0kb and makes the `site/` → `app/` boundary checkable rather than aspirational.
 *
 * Two clients rather than one because they are two registries: `defineApi` keys actions and
 * queries separately, and a read is a `GET /_x/query/<name>` while a write is a `POST` — so
 * `client.publicPost` was never going to resolve, and calling a read off the action client is
 * the shape this file exists to make impossible.
 *
 * There is no codegen step to remember: the shape is inferred from the declarations. A
 * build id travels on every action call — always, defaulting to `dev` exactly as
 * `createContext()` does — so a page left open across a deploy raises `X_CONTRACT_DRIFT` instead
 * of silently posting to an operation that changed shape. A read carries none: a GET that
 * validates its own search string against the read's schema answers `X_INPUT_INVALID` on its own.
 *
 * `APP_URL` and `BUILD_ID` are read here, not in `app.config.ts`: `defineConfig` declares only the
 * env keys the framework itself reads and has no generic `env` block, and these two are the
 * client's own inputs.
 */

import { rpc } from '@ultimat3/action';
import { EnvMissingError } from '@ultimat3/core';
import { useRequestHeader } from '@ultimat3/http';
import { queryClient } from '@ultimat3/query';
import type { Api } from '../api';

/**
 * Resolved on access, never at import: both clients read `baseUrl` only when a method is taken
 * off them, so a missing `APP_URL` fails the call that needed an origin. Throwing at import
 * would take down every test that merely renders a component. An empty string is worse than
 * either — it makes relative requests that appear to work in a browser and fail to parse
 * everywhere else.
 */
function appUrl(): string {
  const url = process.env['APP_URL'];
  if (url === undefined || url === '') {
    throw new EnvMissingError({
      cause: 'APP_URL is unset, so the typed client has no origin to post an action to',
      fix: 'add APP_URL=http://localhost:3000 to .env (copy .env.example), then run: bin/dev',
    });
  }
  return url;
}

export const client = rpc<Api['actions']>({
  get baseUrl() {
    return appUrl();
  },
  // Mirrors `createContext()`'s own default. An absent build id sends no header at all, which
  // turns drift detection off silently — the one failure this file's header promises it catches.
  buildId: process.env['BUILD_ID'] ?? 'dev',
});

/**
 * Every registered read, over `GET /_x/query/<kebab>`: `queries.publicPost({ slug })`. The getter
 * is written out again rather than shared through a spread — spreading evaluates it, which is the
 * import-time throw the one above exists to avoid.
 */
export const queries = queryClient<Api['queries']>({
  get baseUrl() {
    return appUrl();
  },
});

/**
 * The same reads, AS THE MEMBER WHO ASKED — what an `app/` page's `load` calls. A load runs on the
 * server and reaches this app over HTTP, so the read is a second request, and a second request
 * carries only what is put on it: `queries` sends no cookie, the demo authenticator then answered
 * that request as its default member, and every `app/` page loaded ada's view — so `/posts/{id}`
 * answered mara 403 on her own org's post while ada saw hers, and kenji's feed counted Acme as ada.
 *
 * The inbound `cookie`, and nothing else, onto this app's own `APP_URL` — never another origin.
 * `useRequestHeader` and not a try-form on purpose: outside a request it throws `X_NO_REQUEST`,
 * and a member read with no member to forward must refuse rather than fall back to the default
 * one, which is the defect this exists to close. `site/` keeps `queries`: a public read's answer
 * never depends on who asks, and a prerender has no request to forward.
 */
export const memberQueries = queryClient<Api['queries']>({
  get baseUrl() {
    return appUrl();
  },
  get headers() {
    return memberHeaders();
  },
});

/** What `memberQueries` puts on every read: the inbound cookie, or nothing when none was sent. */
export function memberHeaders(): Readonly<Record<string, string>> {
  const cookie = useRequestHeader('cookie');
  return cookie === null ? {} : { cookie };
}
