// One rebuild at a time. A reload is a full `appManifest()` plus a `buildIslands()` over every
// island, and the watcher had no in-flight guard: a 45ms drip of writes — a slow `git checkout`, a
// formatter walking the tree, `x db gen` — started one per file, 40 for 40 files, each assigning
// the same two state slots in COMPLETION order. So a slower earlier rebuild could land on top of a
// newer one, and the dev server then served a manifest built from source that had already changed.

/** What a tick does while a rebuild is already running: nothing, except become the next one. */
export type ReloadTrigger = (file: string) => void;

/**
 * Serialise `run`, keeping only the LAST tick that arrived while it was busy. N ticks during one
 * rebuild are exactly one more rebuild, for the newest file — never N queued ones, and never a
 * dropped tick, which would leave the process serving the state before the author's last save.
 *
 * `onError` defaults to swallowing, because the caller that cares reports its own failure as a
 * finding; a rejection escaping here would be an unhandled rejection that takes `x dev` down.
 */
export function coalesceReloads(
  run: (file: string) => Promise<void> | void,
  onError: (error: unknown, file: string) => void = () => undefined,
): ReloadTrigger {
  let running = false;
  let pending: string | undefined;

  const start = (file: string): void => {
    running = true;
    // `Promise.resolve().then` rather than a bare call: a SYNCHRONOUS throw from `run` would
    // otherwise escape the fs callback that triggered it, where nothing is listening.
    void (async () => await run(file))()
      .catch((error: unknown) => onError(error, file))
      .finally(() => {
        running = false;
        const next = pending;
        pending = undefined;
        if (next !== undefined) start(next);
      });
  };

  return (file: string): void => {
    if (running) {
      pending = file;
      return;
    }
    start(file);
  };
}
