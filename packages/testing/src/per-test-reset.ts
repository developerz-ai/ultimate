// What every test starts from, put back by the preload before each one — the per-TEST half of
// isolation, beside `file-boundary.ts`'s per-file half. Today one thing: the jobs event bus, which
// STORES what it is handed, so an answer one test published resumed the next test's waiting run.

import { beforeEach } from 'bun:test';
import type { resetEventBus } from '@ultimat3/jobs';

let installed = false;

/**
 * The module that holds the ambient bus, when something in this process has loaded it — and only
 * then. A test that never touched `@ultimat3/jobs` has no bus to reset, and loading the package to
 * reset one would put the jobs graph into every `packages/core` test.
 */
function loadedEventsModule(): string | undefined {
  // Resolved once per process: every test asks, and the answer is a path that does not move.
  eventsPath ??= Bun.resolveSync('@ultimat3/jobs', import.meta.dir).replace(
    /index\.ts$/,
    'events.ts',
  );
  return eventsPath in require.cache ? eventsPath : undefined;
}

let eventsPath: string | undefined;

/** Before each test: a fresh ambient event bus, when the jobs package is loaded at all. */
export async function resetPerTestState(): Promise<void> {
  const events = loadedEventsModule();
  if (events === undefined) return;
  // Already evaluated — this import answers from the module registry, the same instance.
  const loaded = (await import(events)) as { readonly resetEventBus: typeof resetEventBus };
  loaded.resetEventBus();
}

/**
 * Called by the app preload (`./preload`), once per process. In a preload, `beforeEach` runs
 * before every test of every file; idempotent so a second caller cannot register it twice.
 */
export function installPerTestReset(): void {
  if (installed) return;
  installed = true;
  beforeEach(resetPerTestState);
}
