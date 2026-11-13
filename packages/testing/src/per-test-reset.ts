// What every test starts from, put back by the preload before each one — the per-TEST half of
// isolation, beside `file-boundary.ts`'s per-file half: the jobs event bus, which STORES what it is
// handed (an answer one test published resumed the next test's waiting run), and the installed
// rate-limit store, read per request (a bucket one test drained was the next test's 429).

import { beforeEach } from 'bun:test';
import type { clearDefaultRateLimitBuckets } from '@ultimat3/http/adapter';
import type { freshDefaultEventBus, resetEventBus } from '@ultimat3/jobs/adapter';
import { onFileBoundary } from './file-boundary';
import { installTestScope } from './test-scope';

let installed = false;

/**
 * `file` of `pkg`, when something in this process has already loaded it — and only then. A test
 * that never touched the package has nothing to reset, and loading it to reset would put its graph
 * into every `packages/core` test. Resolved once per process: the path does not move.
 */
export function loaded(pkg: string, file: string): string | undefined {
  const key = `${pkg}/${file}`;
  let path = paths.get(key);
  if (path === undefined) {
    path = Bun.resolveSync(pkg, import.meta.dir).replace(/index\.ts$/, file);
    paths.set(key, path);
  }
  return path in require.cache ? path : undefined;
}

const paths = new Map<string, string>();

/**
 * Before each test: a fresh DEFAULT event bus and the DEFAULT rate-limit buckets emptied — each
 * only when its package is loaded. Already evaluated, so each import answers from the registry, the
 * same instance. Only the defaults: a bus or store installed for the file (`beforeAll`, a booted
 * app's) stays installed, and carries across that file's tests as it would in production.
 */
export async function resetPerTestState(): Promise<void> {
  const events = loaded('@ultimat3/jobs', 'events.ts');
  if (events !== undefined) {
    const jobs = (await import(events)) as {
      readonly freshDefaultEventBus: typeof freshDefaultEventBus;
    };
    jobs.freshDefaultEventBus();
  }
  const limits = loaded('@ultimat3/http', 'rate-limit-installed.ts');
  if (limits !== undefined) {
    const http = (await import(limits)) as {
      readonly clearDefaultRateLimitBuckets: typeof clearDefaultRateLimitBuckets;
    };
    http.clearDefaultRateLimitBuckets();
  }
}

/**
 * Called by the app preload (`./preload`), once per process. In a preload, `beforeEach` runs
 * before every test of every file; idempotent so a second caller cannot register it twice.
 */
export function installPerTestReset(): void {
  if (installed) return;
  installed = true;
  beforeEach(resetPerTestState);
  // The test doubles' scope rides the same call, so both preloads — the app's and this repo's own
  // `scripts/test-setup.ts` — put every stub and swapped adapter back with no second install line.
  installTestScope();
  // AFTER the scope's own file hook, so a file's swaps are released first: then the whole bus slot
  // goes back to boot state. A frame a file installed and never released — an `afterEach` that
  // "restored" by installing again — would otherwise outlive the file and hand every later test
  // its events, which the per-test fresh DEFAULT bus underneath cannot reach.
  onFileBoundary(resetEventBusAtFileEnd);
}

/** Synchronous, as a file boundary is: the module is already loaded, so `require` answers it. */
function resetEventBusAtFileEnd(): void {
  const events = loaded('@ultimat3/jobs', 'events.ts');
  if (events === undefined) return;
  const jobs = require(events) as { readonly resetEventBus: typeof resetEventBus };
  jobs.resetEventBus();
}
