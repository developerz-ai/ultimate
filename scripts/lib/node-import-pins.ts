// The ratchet under `scripts/node-imports.ts`: how many `node:` imports in each package carry no
// `why:` comment. The number may FALL and may never rise. Data only.
//
// Root `CLAUDE.md` has always said a `node:` import needs "a comment saying why", and nothing read
// that sentence — so 238 of 4,027 files reached for a builtin under a green gate. A ratchet rather
// than a red gate for the reason `test-bare-error.ts` gives at 422 sites and `catch-render.ts` at
// fifteen: a rule that reds a whole tree on the day it lands is a rule somebody turns off.
//
// DRAINING ONE IS ONE LINE. The sentence names the Bun API that does not exist —
// `// why: Bun ships no temp-directory API` above a `mkdtemp` import — and once written the count
// falls and this file's row falls with it. Several packages already carry exactly that sentence in
// prose (`scripts/lib/log.ts`, `scripts/version-stamps.test.ts`) and need only the token.
//
// Shrink it with `bun run scripts/node-imports.ts --unpin <pkg>[,<pkg>]`.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const NODE_PINS_FILE = 'scripts/lib/node-import-pins.ts';

/**
 * Measured 2026-08-23, on the first run: 146 unexplained imports across 10 packages, out of the 238
 * files that import a `node:` builtin at all. `cli` holds 100 of them, which is honest — it is the
 * package that runs processes, writes files and spawns a browser, and it is also where a Bun native
 * landing tomorrow would delete the most code.
 *
 * Every row is a debt, never a decision.
 */
export const NODE_IMPORT_PINS: Readonly<Record<string, number>> = {
  ai: 1,
  cli: 99,
  core: 5,
  db: 2,
  entity: 1,
  manifest: 2,
  render: 3,
  scripts: 28,
  testing: 3,
  ui: 1,
};

/** What this package is allowed to have today. Absent means zero, deliberately. */
export const nodeImportPinnedFor = (
  pkg: string,
  pins: Readonly<Record<string, number>> = NODE_IMPORT_PINS,
): number => (Object.hasOwn(pins, pkg) ? (pins[pkg] ?? 0) : 0);

/**
 * The edit `X_NODE_IMPORT_PIN_STALE` names, performed: lower each named package's count to what is
 * measured, and refuse to raise one. Returns the entries it changed, so the caller can say
 * "nothing to lower" rather than reporting a write it did not make.
 */
export async function applyNodeImportUnpin(
  root: string,
  packages: readonly string[],
  counts: Readonly<Record<string, number>>,
  pins: Readonly<Record<string, number>> = NODE_IMPORT_PINS,
): Promise<readonly string[]> {
  const path = `${root}/${NODE_PINS_FILE}`;
  let text = await Bun.file(path).text();
  const written: string[] = [];
  for (const pkg of packages) {
    const found = counts[pkg] ?? 0;
    if (found >= nodeImportPinnedFor(pkg, pins)) continue;
    // `RegExp.escape`, never the raw key: a name holding regex syntax matches a NEIGHBOURING row.
    const spelt = `(['"]?${RegExp.escape(pkg)}['"]?)`;
    const entry = new RegExp(`^(\\s*)${spelt}: \\d+,$`, 'm');
    if (!entry.test(text)) continue;
    text =
      found === 0
        ? text.replace(new RegExp(`^\\s*${spelt}: \\d+,\\n`, 'm'), '')
        : text.replace(entry, `$1$2: ${String(found)},`);
    written.push(`${pkg} -> ${String(found)}`);
  }
  if (written.length > 0) await Bun.write(path, text);
  return written;
}
