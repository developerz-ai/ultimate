// The ratchet under `scripts/node-imports.ts`: how many `node:` imports in each package carry no
// `why:` comment. The number may FALL and may never rise. Data only.
//
// Root `CLAUDE.md` has always said a `node:` import needs "a comment saying why", and nothing read
// that sentence — so 238 of 4,027 files reached for a builtin under a green gate. A ratchet rather
// than a red gate for the reason `test-bare-error.ts` gives at 422 sites and `catch-render.ts` at
// fifteen: a rule that reds a whole tree on the day it lands is a rule somebody turns off.
//
// A TEST FILE IS IN THE CORPUS, `As of 2026-08-26`. `CLAUDE.md`'s non-negotiable does not exempt
// one, and the `why:` token is worth exactly as much there: it is what lets the next agent delete
// the import when Bun ships the native, and a `mkdtemp` in a suite is as retirable as a `mkdtemp`
// in a driver.
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
 * Measured 2026-08-26, over the corpus a test file is now IN: **545** unexplained imports across 16
 * packages — 141 in shipped source and **404 across 164 test files**, which is where the growth is.
 *
 * The rise is the corpus, never a regression. `checkNodeImports` opened with
 * `if (isTestPath(file.path)) continue` from the day it landed (#365), so the 2026-08-23 row of 146
 * measured shipped source alone and `bun run node-imports` answered green over a package with a
 * dozen unexplained imports in its tests — the same shape `CLAUDE.md` records for the bare-`Error`
 * rule at 422 sites, found the same way and one release apart. `storage` is the proof it mattered:
 * CodeRabbit flagged two of its test files on #364, and `storage` had no row here at all.
 *
 * THIS IS THE ONE TIME A NUMBER HERE MAY RISE, and it rose because the rule started reading files
 * it had always been written to read. It may only fall from here — `scripts/node-imports.test.ts`
 * holds the 2026-08-26 ceiling and refuses a raise past it.
 *
 * Two rows fell as they rose: `cli` lost 4 shipped sites that were app source inside a `templates/`
 * template literal — the CLI writes those files and never runs them — and `scripts` lost 25
 * fixtures its own rules spell as data. Both are the mask, not a sweep.
 *
 * DRAINED TO 209, `As of 2026-08-26`, and the two biggest rows are now shipped source alone:
 * `cli` 360 -> 95 and `scripts` 99 -> 28, which is every one of their 336 test-file sites answered.
 * Nine of those were CONVERTED rather than annotated — `Bun.file(p).exists()`, `Bun.file(p).text()`
 * and `Bun.write()` (which creates intermediate directories, so it is `mkdir -p` too) retired seven
 * whole `node:fs` imports. The rest carry the sentence, because Bun 1.4 exposes no `tmpdir()`, no
 * `mkdtemp`, no recursive remove and no path API at all: `Object.keys(Bun)` has `file`, `write`,
 * `Glob`, `pathToFileURL` and `fileURLToPath`, and nothing that joins a path or makes a directory.
 * The 68 test-file sites left are in the other fourteen packages.
 *
 * Every row is a debt, never a decision. `cli` holding the largest one is honest: it runs
 * processes, writes files and spawns a browser, and it is where a Bun native landing tomorrow
 * deletes the most code. A row is bare on purpose — a sentence beside one reads as a
 * justification, and `--unpin` matches the row whole.
 */
export const NODE_IMPORT_PINS: Readonly<Record<string, number>> = {
  admin: 1,
  ai: 9,
  cli: 94,
  core: 17,
  db: 8,
  entity: 1,
  i18n: 3,
  jobs: 2,
  manifest: 11,
  notify: 1,
  render: 15,
  scraping: 4,
  scripts: 28,
  testing: 12,
  time: 1,
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
