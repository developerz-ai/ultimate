#!/usr/bin/env bun
// Refuse a test file that resets a PROCESS-GLOBAL registry from inside a `.skipIf(` block, where
// the reset never runs in the configuration the block is skipped in.
//
// THE DEFECT THIS EXISTS FOR. Bun evaluates a skipped file's module body — so a module-scope
// `entity()` REGISTERS — and then does not run a hook inside `describe.skipIf(true)`. A
// `clearRegistry()` parked in that hook therefore leaks the entity into every later file in the
// process, where the next same-named `entity()` is an `X_ENTITY_DUPLICATE` nobody can attribute to
// the file that caused it.
//
// Measured 2026-08-26: with `TEST_DATABASE_URL` unset, **19 live suites in `@ultimat3/entity`
// leaked 36 entities**. Nineteen — the leak WAS the house convention, so the two files a review
// named were following it rather than deviating from it, and repairing only those would have left
// 31 of 36 in place. `packages/entity/CLAUDE.md` names `@ultimat3/policy` as the package a leaked
// registry has already broken once.
//
// WHY IT HID. The leak appears only when the suite is SKIPPED, which is the one configuration a
// live suite is never deliberately run in — every developer and every CI job with a database sees
// green. That is why the rule has to be static: no test run in the normal configuration can
// observe it.
//
// WHAT IT CHECKS. A file holding BOTH a `.skipIf(` and a call to a registry reset must make that
// call from a hook at FILE scope — `afterAll(` / `beforeAll(` beginning at column 0 — not from one
// nested inside a `describe`. Two spellings leak and the rule refuses both: the call inside the
// skipped block's own teardown, and a file-scope hook whose body returns early on the same
// condition the block skips on.
//
// `clearTimeout` / `clearInterval` / `clearImmediate` are runtime builtins, not registries, and are
// never reported — the first draft matched them and called a `realtime` live test a violation.
//
// ITS RELATION TO `packages/entity/src/live-registry-cleanup.test.ts`, which came first and is
// NOT a duplicate of this. That one is package-local and STRICTER: it demands the verbatim block
// `afterAll(() => {\n  clearRegistry();\n});` in every `*.live.test.ts` under `packages/entity`,
// because that is the package the leak was measured in and the spelling is worth pinning where 19
// files had to be rewritten at once. This one is repo-WIDE and asks the weaker, more general
// question — is the reset reachable at all when the suite is skipped — so a package that has never
// had the defect cannot acquire it. Today only `entity` files satisfy both; `db` has 13 skipping
// suites and `realtime` 3, and this rule is what stands between them and the same 36-entity leak.
// If entity's spelling rule is ever deleted, this one still holds the floor.
//
// Pinned at ZERO, enforcing outright — the sweep landed first.
//
//   bun run skip-if-cleanup  ·  bun run scripts/skip-if-cleanup.ts [--json] [--explain]

import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'skip-if-cleanup';

/**
 * Listed one per entry.
 *
 * `Bun.Glob` DOES expand braces — but an alternative containing a `/` matches **zero files**:
 * measured, `{packages,scripts}/**` finds 1,309 and `{packages/<any>/src,scripts}` finds none. A
 * pattern that matches nothing reads exactly like a clean tree, which is how this rule's sibling
 * reported a clean answer having scanned no file at all.
 */
const TEST_GLOBS = ['packages/*/src/**/*.test.ts', 'examples/**/*.test.ts', 'dummy/**/*.test.ts'];

const SKIP_IF = /\.skipIf\s*\(/;

/**
 * A process-global registry reset. `Timeout`/`Interval`/`Immediate` are excluded by name: they are
 * runtime builtins that clear a handle, not a registry, and matching them made this rule report a
 * `realtime` live test whose only `clear…(` was a `clearTimeout`.
 */
const RESET = /\b(?:clear|reset)(?!Timeout|Interval|Immediate)[A-Z][A-Za-z]*\s*\(/;

/** A hook opened at column 0 — the only place a reset survives a skipped suite. */
const FILE_SCOPE_HOOK = /^(?:afterAll|beforeAll|afterEach|beforeEach)\s*\(/;

/** A new top-level statement, which ends whatever file-scope hook was open. */
const TOP_LEVEL = /^\S/;

/**
 * An early return inside a file-scope hook: the hook runs, and then does nothing.
 *
 * Both spellings — `if (!ready) return;` and the braced form over two lines. The first draft read
 * only the one-liner, so a braced guard leaked exactly as the nested form does while reading as
 * clean.
 */
const EARLY_RETURN = /^\s{2,}if\s*\(.*\)\s*(?:return\b|\{\s*$)/;
const BRACED_RETURN = /^\s{4,}return\b/;

export interface CleanupFile {
  readonly file: string;
  /** Whether a reset is reached from a file-scope hook with no early return above it. */
  readonly cleared: boolean;
  readonly line: number;
}

/** Every file that both skips and resets, with whether its reset survives the skip. */
export function cleanupFiles(sources: ReadonlyMap<string, string>): readonly CleanupFile[] {
  const out: CleanupFile[] = [];
  for (const [file, src] of sources) {
    if (!SKIP_IF.test(src) || !RESET.test(src)) continue;
    let inHook = false;
    let bailed = false;
    let cleared = false;
    let line = 0;
    const lines = src.split('\n');
    for (const [index, text] of lines.entries()) {
      if (FILE_SCOPE_HOOK.test(text)) {
        inHook = true;
        bailed = false;
      } else if (TOP_LEVEL.test(text)) {
        inHook = false;
      }
      if (inHook && (EARLY_RETURN.test(text) || BRACED_RETURN.test(text))) bailed = true;
      if (inHook && !bailed && RESET.test(text)) {
        cleared = true;
        line = index + 1;
      }
    }
    out.push({ file, cleared, line });
  }
  return out;
}

export interface CleanupInput {
  readonly files: readonly CleanupFile[];
  /** False means the scan read nothing, which must never read as a clean tree. */
  readonly scanned: boolean;
}

export function checkCleanup(input: CleanupInput): readonly Finding[] {
  if (!input.scanned) {
    return [
      {
        code: 'X_SKIP_CLEANUP_UNSCANNED',
        cause: 'no test file was scanned, so no skipped suite was checked',
        fix: 'run `bun run skip-if-cleanup` from the repo root; a Bun.Glob pattern it cannot expand matches zero files',
        at: 'scripts/skip-if-cleanup.ts',
      },
    ];
  }
  return input.files
    .filter((one) => !one.cleared)
    .map((one) => ({
      code: 'X_SKIP_CLEANUP_UNREACHED',
      cause: `${one.file} skips a suite and resets a process-global registry, and no file-scope hook reaches that reset — Bun evaluates a skipped file's module body, so whatever it registers at import leaks into every later file in the process`,
      fix: `move the reset into a hook at column 0 in ${one.file}, e.g. \`afterAll(() => {\\n  clearRegistry();\\n});\`, and guard nothing on the skip condition — a file-scope hook that returns early on the same condition leaks identically. Verify with the suite SKIPPED: run it with the live env var unset alongside another file that registers`,
      at: one.file,
    }));
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const sources = new Map<string, string>();
  let files = 0;
  for (const pattern of TEST_GLOBS) {
    for await (const relative of new Bun.Glob(pattern).scan({ cwd: root })) {
      const path = relative.split('\\').join('/');
      files += 1;
      // The guard that enforces this rule inside `@ultimat3/entity` spells the shapes it refuses,
      // including a skipped block with a reset in it. A rule naming a defect is not the defect —
      // `dead-docs-host` draws the same line for the host it removed.
      if (path.endsWith('live-registry-cleanup.test.ts')) continue;
      sources.set(path, await Bun.file(`${root}/${path}`).text());
    }
  }
  const scanned = cleanupFiles(sources);
  const findings = checkCleanup({ files: scanned, scanned: files > 0 });
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `${String(scanned.length)} test file(s) both skip a suite and reset a registry, every one from a file-scope hook, across ${String(files)} scanned`
          : findings[0]?.code === 'X_SKIP_CLEANUP_UNSCANNED'
            ? 'this rule read nothing, so no skipped suite was checked'
            : `${String(findings.length)} test file(s) whose registry reset never runs when the suite is skipped`,
      findings,
      data: {
        files,
        checked: args.flags.get('explain') === true ? scanned : scanned.length,
      },
    },
    args.json,
  );
}
