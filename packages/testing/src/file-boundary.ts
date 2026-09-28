// "One test file ended, the next begins" — the moment a shared worker process must hand the next
// file the process it would have had alone.
//
// Since 22.7 `x test` / `x verify` run each worker WITHOUT `--isolate`: one global and one module
// registry per worker, reused across every file it runs (2-5x faster, measured in
// `@ultimat3/cli`'s `test-workers.ts`). What a file leaves on `globalThis` then reaches every
// later file on that worker. Measured on notificado.co: one island test that never disposed its
// mount left the fake `window`/`document` installed, PGlite then took the process for a browser
// (`window.location.pathname` of undefined), and 264 unrelated tests failed.
//
// Bun gives a preload no per-file hook. The one signal is a test file being LOADED, which
// `registry-leak-guard.ts` already intercepts; it calls `runFileBoundary()` there, and this module
// owns what happens: the hooks registered with `onFileBoundary` (island mounts disposed first,
// while their fake DOM is still installed), then the globals put back.

type Hook = () => void;

const hooks: Hook[] = [];

/** Run `hook` between every two test files of one worker process. */
export function onFileBoundary(hook: Hook): void {
  hooks.push(hook);
}

/**
 * Globals a file may add and keep: `__`-prefixed helper slots (tslib's `__extends`, seroval's
 * `__SEROVAL_REFS__`) that a module installs ONCE at import and reads back later — the module is
 * cached, so deleting its slot would break the next file that uses it, not protect it.
 */
const kept = (key: string): boolean => key.startsWith('__') || /^\d+$/.test(key);

interface Baseline {
  readonly keys: ReadonlySet<string>;
  readonly descriptors: ReadonlyMap<string, PropertyDescriptor>;
}

let baseline: Baseline | undefined;
let envBaseline: Readonly<Record<string, string | undefined>> | undefined;

/**
 * `process.env` back to what the first file saw: a test that sets `ULTIMATE_EVAL_RECORD` (or any
 * key) and forgets it changes what every later file on the worker reads — measured, the framework's
 * own `verify.run` MCP test then saw the eval step red. Returns the keys it touched.
 */
export function restoreEnv(
  snapshot: Readonly<Record<string, string | undefined>>,
  env: Record<string, string | undefined> = process.env,
): readonly string[] {
  const touched: string[] = [];
  for (const key of Object.keys(env)) {
    if (!(key in snapshot)) {
      delete env[key];
      touched.push(key);
    }
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (env[key] !== value && value !== undefined) {
      env[key] = value;
      touched.push(key);
    }
  }
  return touched;
}

/**
 * The globals the process started with — taken at the FIRST file boundary, not at preload time,
 * so every preload (the app's own, a DOM registrator among them) is part of the baseline.
 */
export function captureGlobals(host: object = globalThis): Baseline {
  const keys = new Set(Object.getOwnPropertyNames(host));
  const descriptors = new Map<string, PropertyDescriptor>();
  for (const key of keys) {
    if (kept(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(host, key);
    if (descriptor !== undefined) descriptors.set(key, descriptor);
  }
  return { keys, descriptors };
}

const same = (a: PropertyDescriptor, b: PropertyDescriptor): boolean =>
  a.value === b.value && a.get === b.get && a.set === b.set;

/**
 * Delete what the last file added and put back what it replaced. Returns the keys it touched, so
 * a test can pin it. A property the host refuses to change is left alone — never a throw here.
 */
export function restoreGlobals(snapshot: Baseline, host: object = globalThis): readonly string[] {
  const record = host as Record<string, unknown>;
  const touched: string[] = [];
  for (const key of Object.getOwnPropertyNames(host)) {
    if (kept(key)) continue;
    if (!snapshot.keys.has(key)) {
      try {
        if (delete record[key]) touched.push(key);
      } catch {
        // Non-configurable: nothing a restore can do, and the run must go on.
      }
      continue;
    }
    const was = snapshot.descriptors.get(key);
    const now = Object.getOwnPropertyDescriptor(host, key);
    if (was === undefined || now === undefined || same(was, now)) continue;
    try {
      Object.defineProperty(host, key, was);
      touched.push(key);
    } catch {
      // Non-configurable and changed: leave it.
    }
  }
  for (const [key, descriptor] of snapshot.descriptors) {
    if (Object.getOwnPropertyDescriptor(host, key) !== undefined) continue;
    try {
      Object.defineProperty(host, key, descriptor);
      touched.push(key);
    } catch {
      // Could not be put back; the next file sees it missing, as it would have anyway.
    }
  }
  return touched;
}

/** Called by the leak guard as each test file loads. The first call only takes the baseline. */
export function runFileBoundary(): void {
  if (baseline === undefined) {
    baseline = captureGlobals();
    envBaseline = { ...process.env };
    return;
  }
  for (const hook of hooks) {
    try {
      hook();
    } catch {
      // A hook that throws (an island's own disposer) must not stop the rest of the reset.
    }
  }
  restoreGlobals(baseline);
  if (envBaseline !== undefined) restoreEnv(envBaseline);
}
