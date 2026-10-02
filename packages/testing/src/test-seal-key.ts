// Single responsibility: the master key a TEST process seals under when the app handed it none.
// `.secrets.key` is gitignored and CI has no `ULTIMATE_SECRETS_KEY`, so without this every test
// over an entity with a `.sealed()` column is `X_SEAL_KEY_MISSING` on a fresh clone. The preload
// is the one caller; the key itself is not exported, from this module or from the package.

import { findMasterKey, SECRETS_KEY_ENV } from '@ultimat3/core';

/**
 * Public by construction — it is in the package on npm — so it protects nothing and must never
 * seal a real row. 64 hex characters, which is all `parseMasterKey` asks of a key.
 */
const TEST_SEAL_KEY = '7e57'.repeat(16);

type EnvRecord = Record<string, string | undefined>;

export interface TestSealKeySource {
  /** The app root a `.secrets.key` would sit in. Defaults to the working directory. */
  readonly root?: string;
  /** Read for the mode and the key, and written to. Defaults to `process.env`. */
  readonly env?: EnvRecord;
}

/**
 * Installs the throwaway key, and answers whether it did. Two refusals, both silent because both
 * are the correct outcome rather than a mistake to report:
 *
 * - **Not a test process.** `bun test` sets `NODE_ENV=test`; anything else — a server that
 *   imported the preload, `NODE_ENV=production` — gets no key, so a sealed write there is still
 *   `X_SEAL_KEY_MISSING` and never a row sealed under a key the whole world holds.
 * - **A key is already there**, in the variable or in `.secrets.key`. The app's own key wins: a
 *   suite that reads the committed `secrets.enc.json` needs the key that sealed it.
 */
export function installTestSealKey(source: TestSealKeySource = {}): boolean {
  const env = source.env ?? (process.env as EnvRecord);
  const added = testSealKeyEnv({ ...source, env });
  Object.assign(env, added);
  return SECRETS_KEY_ENV in added;
}

/**
 * The same decision as a value: the variable to ADD to a child's environment, or nothing. For a
 * harness that spawns the app under test (`startE2eApp`) — the child is a server, not a `bun test`
 * process, so it can never install a key for itself, and it must not be able to. The rule is still
 * judged in THIS process: only a test process hands the key down.
 */
export function testSealKeyEnv(source: TestSealKeySource = {}): Readonly<Record<string, string>> {
  const env = source.env ?? (process.env as EnvRecord);
  if (env['NODE_ENV'] !== 'test') return {};
  if (findMasterKey(source.root ?? process.cwd(), env) !== undefined) return {};
  return { [SECRETS_KEY_ENV]: TEST_SEAL_KEY };
}
