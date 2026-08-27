// The ratchet under `scripts/test-bare-error.ts`: how many of each package's own TESTS report their
// verdict by throwing a bare `Error`. The number may FALL and may never rise. Data only — the gate
// owns what it does with these.
//
// Measured 2026-08-20: 266 across 24 packages, under a green gate. `CLAUDE.md` has always said
// never throw a bare `Error`, and `checkErrorFixes` opens with `if (isTest(path)) continue`, so in
// test files the rule was prose — which axiom 3 says is no rule at all. #132 counted 295 `new
// Error(` sites; the total is now 422, and that growth is the argument for a rule over a sweep.
//
// WHAT IS COUNTED, and it is not every `new Error`. Only `throw new Error(…)` — the test stating
// its own verdict. A `new Error` that is NOT thrown is the subject's INPUT and is not reported at
// all: `Promise.reject(new Error('redis is down'))`, `render(new Error('the driver went away'))`,
// `Object.assign(new Error('denied'), { code, cause, fix })`. That is 159 sites here, and
// `packages/realtime/CLAUDE.md` already blesses the shape — "the rule governs what this package
// throws, never what a test hands it". Rebuilding those would change what the tests prove.
//
// THE HONEST LIMIT: a stub that throws AT the subject — `{ get: () => { throw new Error('boom') } }`
// — is also an input, and it is counted here because text cannot tell it from a verdict. So a pin
// will not always reach zero, and a package should stop lowering when what is left is stubs. That
// is a smaller and more honest residue than 422 unguarded sites.
//
// The replacement for a verdict is `expect.unreachable('<what was expected>')`, this repo's own
// idiom (10+ uses in `packages/realtime/src/`): it reports at the assertion with the value that
// actually arrived, and its `never` return narrows the variable so the cast under it goes away.
//
// Shrink it with `bun run scripts/test-bare-error.ts --unpin <pkg>[,<pkg>]`, which lowers a count
// to what is measured and refuses to raise one. Raising a count is a hand edit, in a review.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const PINS_FILE = 'scripts/lib/test-bare-error-pins.ts';

export const BARE_ERROR_PINS: Readonly<Record<string, number>> = {
  admin: 7,
  ai: 18,
  auth: 6,
  cache: 3,
  cli: 9,
  core: 30,
  db: 24,
  entity: 17,
  flags: 1,
  http: 11,
  jobs: 23,
  mcp: 6,
  query: 11,
  realtime: 28,
  render: 6,
  scraping: 1,
  seo: 8,
  testing: 19,
  time: 1,
  ui: 13,
};

/** What this package is allowed to have today. Absent means zero, deliberately. */
export const bareErrorPinnedFor = (
  pkg: string,
  pins: Readonly<Record<string, number>> = BARE_ERROR_PINS,
): number => pins[pkg] ?? 0;

/**
 * The edit `X_TEST_BARE_ERROR_PIN_STALE` names, performed: lower each named package's pin to what
 * is measured, and refuse to raise one. Returns the entries it changed, so the caller can say
 * "nothing to lower" rather than reporting a write it did not make.
 */
export async function applyBareErrorUnpin(
  root: string,
  packages: readonly string[],
  counts: Readonly<Record<string, number>>,
): Promise<readonly string[]> {
  const path = `${root}/${PINS_FILE}`;
  let text = await Bun.file(path).text();
  const written: string[] = [];
  for (const pkg of packages) {
    const found = counts[pkg] ?? 0;
    const pinned = bareErrorPinnedFor(pkg);
    if (found >= pinned) continue;
    const entry = new RegExp(`^(\\s*)${pkg}: \\d+,$`, 'm');
    if (!entry.test(text)) continue;
    text =
      found === 0
        ? text.replace(new RegExp(`^\\s*${pkg}: \\d+,\\n`, 'm'), '')
        : text.replace(entry, `$1${pkg}: ${String(found)},`);
    written.push(`${pkg} -> ${String(found)}`);
  }
  if (written.length > 0) await Bun.write(path, text);
  return written;
}
