/**
 * Postly's `RuntimeOverrides`, read by `x dev` and `apps/web/server.ts` alike: the plain routes no
 * primitive projects to — the partner authorization server's RFC 6749 wire,
 * `/.well-known/oauth-authorization-server` and `POST /oauth/{token,revoke,introspect}` — and the
 * `errorReporter` port, Postly's error-group sink.
 */

import type { RuntimeOverrides } from '@ultimat3/cli/serve';
import { storeMode } from '@ultimat3/core';
import { errorSink } from './app/errors/reporting';
import { partnerOAuth } from './app/partners/oauth';

/**
 * The sink in every process but a test's, by `storeMode`: under `bun test` a job a test dead-letters
 * on purpose would be reported, grouped, and enqueue `openErrorIssue` into that test's own queue.
 * The sink itself is tested directly (`app/errors/reporting.job.test.ts`).
 */
const reporting = storeMode(Bun.env) === 'database' ? { errorReporter: errorSink } : {};

export const runtime = { routes: partnerOAuth.routes, ...reporting } satisfies RuntimeOverrides;
