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
