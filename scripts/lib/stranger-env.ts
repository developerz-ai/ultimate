// The environment every child runs in when it is code this checkout did not write: the published
// `create-ultimate`, a scaffolded app's `x`, a tutorial's fences. PROTECTS: the environment (an
// allowlist — Bun loads the repo's `.env`, `NPM_TOKEN` and all, into this process) and home-dir
// config (`HOME`, `USERPROFILE`, `XDG_*`, `APPDATA`, `BUN_INSTALL` point at a throwaway tree, npm's
// user config at the null device — so no `~/.npmrc` token, `~/.config/gh`, `~/.docker/config.json`
// or `~/.ssh` is found by name). CANNOT protect: a read by absolute path — the child is this uid,
// and `<repo>/.env` or `/home/<me>/.ssh` stay readable. Only a container or a separate uid closes
// that; keep secrets out of the checkout.

// why: Bun has no mkdir, temp-directory or recursive-remove API; `node:fs` owns the throwaway home.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(); only `node:os` answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { serviceKeys } from './coverage-schedule';

/**
 * What a child may inherit: the OS (`PATH`, locale, temp root; Windows' own names, matched without
 * case because Windows spells `Path`), CI's flag, and where a browser is (`CHROME_PATH`,
 * `PUPPETEER_EXECUTABLE_PATH`, read by `@ultimat3/scraping`'s `chromeCandidates`). Nothing that
 * names a home: those are `strangerHome`'s. No credential: `stranger-env.test.ts` refuses a name
 * that reads like one.
 */
export const STRANGER_KEYS: readonly string[] = [
  'PATH',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'CI',
  'CHROME_PATH',
  'PUPPETEER_EXECUTABLE_PATH',
  'E2E_BROWSER_REQUIRED',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
];

/** The test database a child may use. Never `DATABASE_URL` itself: a maintainer's shell may point it at a real one. */
const TEST_DATABASE = 'TEST_DATABASE_URL';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * `parent`'s allowlisted keys and `services` (the test-service URLs — `serviceKeys()` in
 * `scripts/lib/coverage-schedule.ts` reads them off `docker/test-services.env`) bar
 * `DATABASE_URL`, which is `TEST_DATABASE_URL` or absent; then `set` over them. Every other key is
 * dropped.
 */
export function strangerEnv(
  parent: Env,
  services: readonly string[],
  set: Readonly<Record<string, string>>,
): Record<string, string> {
  const allowed = new Set(
    [...STRANGER_KEYS, ...services]
      .map((key) => key.toUpperCase())
      .filter((key) => key !== 'DATABASE_URL'),
  );
  const env = new Map<string, string>();
  for (const [key, value] of Object.entries(parent))
    if (value !== undefined && allowed.has(key.toUpperCase())) env.set(key, value);
  const testDatabase = parent[TEST_DATABASE];
  if (testDatabase !== undefined && services.includes(TEST_DATABASE))
    env.set('DATABASE_URL', testDatabase);
  for (const [key, value] of Object.entries(set)) env.set(key, value);
  return Object.fromEntries(env);
}

/** The Bun package cache `parent` uses — read-only to a child in spirit, packages and no secret. */
const bunCache = (parent: Env): string | undefined =>
  parent['BUN_INSTALL_CACHE_DIR'] ??
  (
    parent['BUN_INSTALL'] ??
    (parent['HOME'] === undefined ? undefined : join(parent['HOME'], '.bun'))
  )?.concat('/install/cache');

/**
 * Every variable that names a home, pointed under `under` (created here), and npm's user config at
 * the null device. `warmCache` hands the child this machine's Bun package cache by path — what CI
 * restores, and holds packages, not credentials; the first-hour bench passes `false`, because a
 * cold cache is what it measures.
 */
export function strangerHome(
  under: string,
  parent: Env,
  warmCache: boolean,
): Record<string, string> {
  const home = join(under, 'home');
  const dirs = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    BUN_INSTALL: join(under, 'bun'),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const cache = warmCache ? bunCache(parent) : undefined;
  return {
    ...dirs,
    NPM_CONFIG_USERCONFIG: process.platform === 'win32' ? 'NUL' : '/dev/null',
    ...(cache === undefined ? {} : { BUN_INSTALL_CACHE_DIR: cache }),
  };
}

/** The whole env for a child: the allowlist, the test-service URLs, a throwaway home under `under`. */
export const strangerChild = (
  parent: Env,
  services: readonly string[],
  under: string,
  options: { readonly warmCache?: boolean; readonly set?: Readonly<Record<string, string>> } = {},
): Record<string, string> =>
  strangerEnv(parent, services, {
    ...strangerHome(under, parent, options.warmCache ?? false),
    ...options.set,
  });

/**
 * The same env as an `exec` overlay. `exec` merges onto `Bun.env`, so every key `parent` holds
 * and `env` lacks is named `undefined` — `exec`'s "unset" — or it would survive the merge.
 */
export function asOverlay(
  parent: Env,
  env: Readonly<Record<string, string>>,
): Record<string, string | undefined> {
  const overlay = new Map<string, string | undefined>();
  for (const key of Object.keys(parent)) overlay.set(key, undefined);
  for (const [key, value] of Object.entries(env)) overlay.set(key, value);
  return Object.fromEntries(overlay);
}

/** One throwaway home per process, removed when it exits — every site in a script shares it. */
let processHome: string | undefined;
const throwawayHome = (): string => {
  if (processHome === undefined) {
    const made = mkdtempSync(join(tmpdir(), 'stranger-home-'));
    processHome = made;
    process.on('exit', () => rmSync(made, { recursive: true, force: true }));
  }
  return processHome;
};

/** Removes this process's throwaway home now — for a caller, like a test runner, whose `exit` never fires. */
export const disposeStrangerHome = (): void => {
  if (processHome !== undefined) rmSync(processHome, { recursive: true, force: true });
  processHome = undefined;
};

/**
 * The one call every site makes: this process's allowlisted keys, the test-service URLs
 * `docker/test-services.env` under `root` names, this process's throwaway home with the warm Bun
 * cache, then `set`. A whole env — for `run()`, or for `Bun.spawn`'s `env`, which replaces.
 */
export const strangerEnvAt = (
  root: string,
  set: Readonly<Record<string, string>> = {},
): Record<string, string> =>
  strangerChild(Bun.env, serviceKeys(root), throwawayHome(), { warmCache: true, set });

/**
 * `strangerEnvAt` as an `exec` overlay (`@ultimat3/cli`'s `exec` merges onto `Bun.env`): every key
 * this process holds and the allowlist does not is unset.
 */
export const strangerOverlayAt = (
  root: string,
  set: Readonly<Record<string, string>> = {},
): Record<string, string | undefined> => asOverlay(Bun.env, strangerEnvAt(root, set));
