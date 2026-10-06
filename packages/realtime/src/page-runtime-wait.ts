// What a realtime island waits on before its first hook runs: the page runtime, installed ONCE per
// page. A document the server rendered for a principal carries it in the page boot (a deferred
// classic script); every other document — a static export, an anonymous page, an app with no sync
// node — gets it from the runtime chunk the island loads itself. Never both, never twice.

import { deferredScriptsPending, peekPageRealtime } from './page-store';

export interface AwaitPageRuntimeOptions {
  /**
   * The path every page boot is served under (`/_x/page-boot/`). A `<script>` whose `src` starts
   * with it is the boot this document carries, and the runtime is coming with it.
   */
  readonly boot: string;
  /** Imports the runtime chunk — only on a page whose boot is absent, or never ran. */
  readonly load: () => Promise<unknown>;
}

type Listenable = {
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
};

const installed = (): boolean => {
  const page = peekPageRealtime();
  return page?.store !== undefined && page.services !== undefined;
};

/**
 * Resolves once the page runtime is installed. An island can be imported while the parser still
 * waits on the deferred boot (the idle callback fires first), so a boot that may still run is
 * waited for — its `load`, its `error`, or DOMContentLoaded, which fires after every deferred
 * script — and a page it never installed the runtime on loads the chunk. Never on a FUTURE event
 * once the deferred scripts are done: a boot that failed before the island asked fires none again.
 */
export async function awaitPageRuntime(options: AwaitPageRuntimeOptions): Promise<void> {
  if (installed()) return;
  const boot = bootElement(options.boot);
  if (boot !== undefined) await firstOf(boot);
  if (!installed()) await options.load();
}

/** The page boot's `<script>` while it may still run; `undefined` once it cannot, or with none. */
function bootElement(prefix: string): Listenable | undefined {
  const doc: unknown = Reflect.get(globalThis, 'document');
  if (typeof doc !== 'object' || doc === null) return undefined;
  // Every deferred script has run: a boot that installed nothing failed, and is not coming.
  if (!deferredScriptsPending()) return undefined;
  const query: unknown = Reflect.get(doc, 'querySelector');
  // A partial document (a component test's stand-in) has no query surface: no tag, no boot.
  if (typeof query !== 'function') return undefined;
  const found: unknown = Reflect.apply(query, doc, [`script[src^="${prefix}"]`]);
  return isListenable(found) ? found : undefined;
}

function isListenable(value: unknown): value is Listenable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'addEventListener') === 'function'
  );
}

/** The boot ran, failed, or every deferred script is done — whichever comes first. */
function firstOf(boot: Listenable): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => resolve();
    boot.addEventListener('load', done, { once: true });
    boot.addEventListener('error', done, { once: true });
    const doc: unknown = Reflect.get(globalThis, 'document');
    if (isListenable(doc)) doc.addEventListener('DOMContentLoaded', done, { once: true });
    if (typeof addEventListener === 'function') addEventListener('load', done, { once: true });
  });
}
