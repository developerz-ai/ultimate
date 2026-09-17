// Single responsibility: which env keys reached THIS `x` process only because Bun auto-loaded
// `.env.development` / `.env.development.local` at startup — so a `bun test` child this process
// spawns (`test-shards.ts`, `verify-tests.ts`, `verify-test-run.ts`, `mcp-host.ts`'s `runTests`)
// does not inherit a key a bare `bun test` would never have seen.
//
// PROBED ON BUN 1.4.2, and the probe decided the rule: an ambient env var SHADOWS a dotenv file's
// own value for the same key (`FOO=dev bun test` with a fixture `.env.test` declaring `FOO=test`
// still read `FOO=dev` inside the test). So a leaked key is never made safe by a legitimate test
// file (`.env`, `.env.test`, …) also declaring it — if we left it in place, the leaked value would
// go on shadowing that file's own value exactly as it shadows `.env.test` above. The only question
// worth asking is the one `devOnlyLeakedKeys` answers: does this process's CURRENT value match
// what `.env.development`/`.env.development.local` would have set? If yes, delete it and let the
// child's own dotenv load (or absence of one) answer instead. If the current value differs, this
// process's env holds something dotenv did not put there — a real export, CI, `.env.local` — and
// deleting it is not this function's call to make.
//
// KNOWN LIMITATION, stated rather than hidden: a real ambient value that happens to COINCIDE with
// the dev file's value is indistinguishable from a leak from here — there is no pre-dotenv
// snapshot to compare against. This function resolves that ambiguity toward closing the leak.
//
// A SECOND PARSER, not a call to `env-example.ts`'s `parseEnvKeys`: that function is deliberately
// keys-only ("half of them are placeholders" — it feeds `.env.example` rendering, where a secret's
// value must never appear), and widening it to return values would change what a template
// generator ships. This one exists to COMPARE values, a different job with a different file.

import { readFileSync } from 'node:fs'; // why: Bun ships no synchronous file read with a graceful-missing return.
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';

/** Bun's own grammar, matched against `env-example.ts`'s `ENV_KEY_RE` (kept separate: see header). */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * One dotenv file's key/value pairs. A `Map`, not an object literal: a key of `constructor` or
 * `__proto__` passes `ENV_KEY_RE` and reads back as a function on `Object.prototype`, the exact
 * defect this repo's `verify-tests.ts` header names thirteen instances of.
 *
 * Quoting: a value opening with `"` or `'` runs to its closing quote (or end of value if the
 * dotenv file never closes it), `#` included — Bun does not stop a quoted value at an internal
 * `#`. An unquoted value stops at the first `#`, which is where an inline comment starts.
 */
export function parseDotenvValues(text: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!ENV_KEY_RE.test(key)) continue;
    const rest = line.slice(separator + 1).trim();
    const quote = rest.startsWith('"') || rest.startsWith("'") ? rest[0] : undefined;
    if (quote === undefined) {
      const hash = rest.indexOf('#');
      values.set(key, (hash >= 0 ? rest.slice(0, hash) : rest).trim());
      continue;
    }
    const closing = rest.indexOf(quote, 1);
    values.set(key, closing >= 0 ? rest.slice(1, closing) : rest.slice(1));
  }
  return values;
}

export interface DevOnlyLeakInput {
  /** `.env.development`'s text, or `''` when the file does not exist. */
  readonly devText: string;
  /** `.env.development.local`'s text, or `''` — wins over `devText` for a shared key, Bun's own precedence. */
  readonly devLocalText: string;
  /** This process's environment, as `exec.ts` would spawn a child with it (before any override). */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * The pure decision, no filesystem: every key `.env.development`/`.env.development.local` would
 * set, where `env`'s CURRENT value for that key is exactly what the file would have set. See this
 * file's header for why a legitimate test file declaring the same key does not exempt it.
 */
export function devOnlyLeakedKeys(input: DevOnlyLeakInput): readonly string[] {
  const merged = new Map(parseDotenvValues(input.devText));
  for (const [key, value] of parseDotenvValues(input.devLocalText)) merged.set(key, value);
  const leaked: string[] = [];
  for (const [key, devValue] of merged) {
    if (input.env[key] === devValue) leaked.push(key);
  }
  return leaked;
}

/** A missing dotenv file is the common case (no `.env.development.local` in most checkouts). */
function readIfPresent(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * The env override a `bun test` child spawned FROM `root` should get: every dev-only leaked key
 * deleted. `exec.ts`'s `ExecOptions.env` reads an `undefined` value as "unset for this child,
 * even though the parent has it" — see that file for why the merge could not otherwise express
 * a deletion.
 *
 * `root` is the app/repo root the caller already resolved — NOT necessarily `process.cwd()`, which
 * is what Bun actually auto-loaded `.env.development` relative to at this process's own startup.
 * The two agree for every command that boots from the repo/app root, which is every one of them
 * today; a future command invoked from a subdirectory would fail SAFE here (the file this reads
 * would differ from the one Bun loaded, values would not match, and nothing gets stripped) rather
 * than stripping the wrong key.
 */
export function testEnvOverrides(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const leaked = devOnlyLeakedKeys({
    devText: readIfPresent(join(root, '.env.development')),
    devLocalText: readIfPresent(join(root, '.env.development.local')),
    env,
  });
  const overrides: Record<string, string | undefined> = {};
  for (const key of leaked) overrides[key] = undefined;
  return overrides;
}
