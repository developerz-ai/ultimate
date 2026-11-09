// The gate's second serial lane: `e2e` beside `live` in a package monorepo, isolated from it by
// construction. Split from `verify-run.ts`, which owns the order; this file owns the one condition
// under which two serial suites may share the machine, and the environment that makes it safe.

// why: Bun ships no synchronous existence check or path join.
import { existsSync } from 'node:fs';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { APP_CONFIG_FILE } from '@ultimat3/core';
import type { Runner } from './exec';
import type { VerifyContext } from './verify-step';

/**
 * What a service URL is called: every `TEST_*_URL` the suites read (`docker/test-services.env`) and
 * `DATABASE_URL`, which `@ultimat3/testing`'s template database falls back to. A child of the lane
 * sees none of them, so whatever it runs, it cannot reach the server `live` is using.
 */
export const isServiceUrlKey = (key: string): boolean =>
  key === 'DATABASE_URL' || /^TEST_[A-Z0-9_]*_URL$/.test(key);

/**
 * Whether `e2e` may run beside `live`. Both serial, and serial for reasons that do not meet: `live`
 * holds a cluster-wide replication slot, `e2e` one browser profile and the built output. In a
 * package monorepo the e2e suite boots throwaway apps on free ports and strips every service URL
 * itself (`packages/cli/e2e/*`), and `besideLive` below makes that true of every file. An APP's
 * e2e boots the app against the services its own live suite uses, so an app keeps them in order.
 */
export const e2eBesideLive = (ctx: Pick<VerifyContext, 'root'>): boolean =>
  !existsSync(join(ctx.root, APP_CONFIG_FILE));

/** `ctx` with every child its runner starts stripped of each service URL in `env`. */
export function besideLive(ctx: VerifyContext): VerifyContext {
  // Both: a child inherits the process environment, so a URL only `Bun.env` holds reaches it even
  // when the caller handed `ctx.env`.
  const keys = new Set([...Object.keys(Bun.env), ...Object.keys(ctx.env ?? {})]);
  const strip: Record<string, undefined> = {};
  for (const key of keys) if (isServiceUrlKey(key)) strip[key] = undefined;
  const runner: Runner = (command, options) =>
    ctx.runner(command, { ...options, env: { ...options.env, ...strip } });
  return { ...ctx, runner };
}
