// From a generator's file list to the disk: one entry per path, catalogs merged rather than
// clobbered, and nothing written at all if any file would conflict. Split from `cmd-generate.ts`,
// which decides WHICH files a generator emits — this file decides what happens to them, and `x new`
// and the scaffold fixture assemble their own lists and land them through exactly these rules.

// `resolve`/`sep` and not `join`: only resolving the assembled path can prove it stayed inside the
// app root, and `node:path` is the only API that resolves one. `node:fs` for the exists check.
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { GenerateJsonInvalidError, ScaffoldPathEscapeError } from './errors';
import { mergeJsonDeep } from './json-merge';
import type { Finding } from './output';
import type { GeneratedFile } from './templates';

/** `undefined` when `text` does not parse as a JSON object — the one shape every catalog, whether
 * generated or hand-edited on disk, must hold. */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/** Deterministic catalog bytes: sorted keys, 2-space indent, trailing newline — a diff shows only
 * the keys a run actually changed, never a reordering. */
function prettyJson(value: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/**
 * Two generators can legitimately produce the same shared file. A plain file (errors.ts) keeps
 * first-write-wins; a `merge: 'json'` catalog instead merges every contributor's keys into one
 * file — `resourceFiles` and `routeFiles` both target the same locale's catalog, and a plain
 * overwrite would drop whichever generator ran first. Later entries fill keys the earlier one
 * lacks; the first occurrence wins a clash, the same rule `writeFiles` applies against the copy
 * already on disk. Exported so `x new` (`cmd-new.ts`) and the scaffold fixture resolve a shared
 * catalog the identical way — one merge rule, not three hand-copied ones.
 *
 * A `merge: 'json'` file's `contents` are the generator's own output, not user data — one that
 * fails to parse as a JSON object is a bug in the template that produced it, so it throws here
 * rather than being silently treated as `{}` and merged into (or written as) a catalog with
 * attribution to nobody. `writeFiles`/`mergeJsonFile` never see a malformed *generated* payload in
 * practice: every production caller (`generate()` below, `cmd-new.ts`'s `planNewApp()`, the
 * scaffold fixture) runs its file list through this function first.
 */
export function dedupe(files: readonly GeneratedFile[]): readonly GeneratedFile[] {
  const seen = new Map<string, GeneratedFile>();
  for (const file of files) {
    if (file.merge === 'json' && parseJsonObject(file.contents) === undefined) {
      throw new GenerateJsonInvalidError({ path: file.path });
    }
    const prior = seen.get(file.path);
    if (prior === undefined) {
      seen.set(file.path, file);
    } else if (prior.merge === 'json' && file.merge === 'json') {
      // Both sides already proved parseable above — the fallback only guards a future change to
      // that invariant, it never fires today. Deep: two generators contributing to one nested
      // catalog share top-level keys (`app`, `admin`), and a shallow spread drops one of them.
      const later = parseJsonObject(file.contents) ?? {};
      const earlier = parseJsonObject(prior.contents) ?? {};
      const { merged } = mergeJsonDeep(earlier, later);
      seen.set(file.path, { ...prior, contents: prettyJson(merged) });
    }
    // else: not mergeable — first write wins, exactly as it always has.
  }
  return [...seen.values()];
}

export interface WriteReport {
  readonly written: readonly string[];
  readonly conflicts: readonly Finding[];
}

/**
 * `GeneratedFile.path` is documented as relative-POSIX, not enforced as it: `join` would happily
 * walk out of the app on a `..` segment or ignore the root entirely on an absolute path. Proven
 * before the write, once per file, because after the write there is nothing left to prove.
 */
export function containedPath(root: string, path: string): string {
  const base = resolve(root);
  const target = resolve(base, path);
  if (target !== base && !target.startsWith(`${base}${sep}`))
    // The default `fix` names the scaffold gate's own test, which repairs nothing for someone
    // running `x g`: the fix here is the generate command, re-run as a dry run.
    throw new ScaffoldPathEscapeError({
      path,
      dir: base,
      // Command first, the caveat behind a `#`: the line runs verbatim and the shell drops the
      // rest. `x g <kind> <name>` pasted into bash is a redirect, not a command.
      fix: `x g resource posts --dry-run   # name every file relative to the app root, no ".." segment`,
    });
  return target;
}

/**
 * A `merge: 'json'` catalog is never a conflict on existence and never subject to `--force`: an
 * existing key on disk always wins, because it may hold a human translation, and only genuinely
 * new keys are added — so a second, third… generator run keeps growing the same file instead of
 * fighting over it. A file that exists but does not parse as a JSON object cannot be merged into
 * without risking silent data loss, so that alone is reported rather than clobbered or thrown past.
 *
 * Typed to the `merge: 'json'` variant alone, not the general `GeneratedFile` union: a
 * byte-carrying file has no `contents: string` to merge, and this is what stops one from ever
 * reaching `parseJsonObject` even if a future caller forgets the `file.merge === 'json'` guard
 * its one call site already applies.
 */
async function planJsonMerge(
  file: Extract<GeneratedFile, { merge: 'json' }>,
  absolute: string,
): Promise<WritePlan> {
  const generated = parseJsonObject(file.contents) ?? {};
  if (!existsSync(absolute))
    return { kind: 'write', file, absolute, contents: prettyJson(generated) };
  const existing = parseJsonObject(await Bun.file(absolute).text());
  if (existing === undefined) {
    return {
      kind: 'conflict',
      finding: {
        code: 'X_GENERATE_CONFLICT',
        cause: `${file.path} exists but is not a JSON object, so its keys cannot be merged`,
        fix: `edit ${file.path} by hand until it parses as a JSON object, or delete it and re-run x g`,
        docs: 'https://ultimate.dev/errors/X_GENERATE_CONFLICT',
        at: file.path,
      },
    };
  }
  // An existing key wins because it may hold a human translation; only the new keys are added.
  // Deep, so a nested catalog gains `site.blog.title` without losing the rest of `site`.
  const { merged, gained } = mergeJsonDeep(existing, generated);
  // Every key the generator wants is already there — leave the file untouched and unclaimed.
  if (!gained) return { kind: 'skip' };
  return { kind: 'write', file, absolute, contents: prettyJson(merged) };
}

/**
 * What one generated file would do, decided without doing it. The merge case computes its own
 * bytes here rather than at the write, so the two passes below cannot disagree about a file.
 */
type WritePlan =
  | {
      readonly kind: 'write';
      readonly file: GeneratedFile;
      readonly absolute: string;
      readonly contents: string | Uint8Array;
    }
  | { readonly kind: 'skip' }
  | { readonly kind: 'conflict'; readonly finding: Finding };

function planFile(
  file: GeneratedFile,
  absolute: string,
  force: boolean,
  invocation: string,
): WritePlan {
  // A foundation file belongs to the slice, not to the generator that needs it: several generators
  // emit the same `repo.ts`, so an existing one is the author's — never a conflict, and never
  // overwritten, `--force` included. `--force` is about the primitive the author named; clobbering
  // `policy.ts` to regenerate one action would delete every rule they wrote. Regenerating a slice
  // module is `x g entity|policy`.
  if (file.merge === 'if-absent') {
    return existsSync(absolute)
      ? { kind: 'skip' }
      : { kind: 'write', file, absolute, contents: file.contents };
  }
  if (!force && existsSync(absolute)) {
    return {
      kind: 'conflict',
      finding: {
        code: 'X_GENERATE_CONFLICT',
        cause: `${file.path} already exists`,
        // The caller's own invocation, not `x g <kind>`: `x g --force` is X_CLI_UNKNOWN_COMMAND
        // when run, and a `fix:` is copied and pasted verbatim. Same construction as
        // `generate-kinds.ts`'s `assertSurfaceSupported`.
        fix: `${invocation} --force   # overwrites ${file.path}, or pass a different name`,
        docs: 'https://ultimate.dev/errors/X_GENERATE_CONFLICT',
        at: file.path,
      },
    };
  }
  return { kind: 'write', file, absolute, contents: file.contents };
}

/**
 * Never clobbers, and never half-writes. A generator that overwrites is a generator nobody runs
 * twice; a generator that lands four of seven files and then reports a conflict is worse, because
 * the next run conflicts on the files the failed one wrote.
 *
 * Two passes, and the split is the point: the first decides — containment, existence, whether a
 * catalog can be merged into — and touches nothing, the second writes only when the first found
 * no conflict at all. Containment was already proven up front and the rest was not.
 */
export async function writeFiles(
  root: string,
  files: readonly GeneratedFile[],
  force: boolean,
  /**
   * The command line that produced these files, so a conflict's `fix:` can hand it back with
   * `--force` on the end. Optional for a caller assembling files itself; the fallback is the
   * shape, not a runnable line, and every generator path supplies the real one.
   */
  invocation = 'x g <kind> <name>',
): Promise<WriteReport> {
  const plans: WritePlan[] = [];
  for (const file of files) {
    const absolute = containedPath(root, file.path);
    plans.push(
      file.merge === 'json'
        ? await planJsonMerge(file, absolute)
        : planFile(file, absolute, force, invocation),
    );
  }
  const conflicts = plans.flatMap((plan) => (plan.kind === 'conflict' ? [plan.finding] : []));
  if (conflicts.length > 0) return { written: [], conflicts };

  const written: string[] = [];
  for (const plan of plans) {
    if (plan.kind !== 'write') continue;
    // Bun.write creates missing parent directories, so a generator never needs an mkdir step.
    await Bun.write(plan.absolute, plan.contents);
    written.push(plan.file.path);
  }
  return { written, conflicts: [] };
}
