/**
 * Postly's `RuntimeOverrides`, read by `x dev` and `apps/web/server.ts` alike: the plain routes no
 * primitive projects to — the partner authorization server's RFC 6749 wire,
 * `/.well-known/oauth-authorization-server` and `POST /oauth/{token,revoke,introspect}` — and the
 * `errorReporter` port, Postly's error-group sink — and the `auditSink` `issueRunKey`'s
 * `audit: true` writes to.
 */

import { memoryAuditSink, postgresAuditSink } from '@ultimat3/action';
import type { RuntimeOverrides } from '@ultimat3/cli/serve';
import { storeMode } from '@ultimat3/core';
import { dbExecutor } from '@ultimat3/db';
import { errorSink } from './app/errors/reporting';
import { partnerOAuth } from './app/partners/oauth';

/**
 * The sink in every process but a test's, by `storeMode`: under `bun test` a job a test dead-letters
 * on purpose would be reported, grouped, and enqueue `openErrorIssue` into that test's own queue.
 * The sink itself is tested directly (`app/errors/reporting.job.test.ts`).
 */
const reporting = storeMode(Bun.env) === 'database' ? { errorReporter: errorSink } : {};

/**
 * By `storeMode`, as every store Postly picks: `x_audit` over the boot's pool where the app's rows
 * live in the database, memory where they live in memory (a test-mode boot). A unit test boots
 * nothing, and swaps its own (`swapAdapter('auditSink', memoryAuditSink())`).
 */
const auditSink =
  storeMode(Bun.env) === 'database'
    ? postgresAuditSink({ executor: dbExecutor() })
    : memoryAuditSink();

export const runtime = {
  routes: partnerOAuth.routes,
  auditSink,
  ...reporting,
} satisfies RuntimeOverrides;
