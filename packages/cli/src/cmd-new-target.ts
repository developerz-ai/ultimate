// `x new`'s refusal of a target directory that already exists. Its fix names a FREE directory —
// never `--force`: a fix is pasted with no diff in front of it, and `--force` over an existing app
// reset its `api/index.ts` and `roles.ts` to the template (D1, 2026-11-16). `--force` writes only
// into free paths: one planned path already on disk refuses the run (round 3, 2026-11-16).

// why: the target is a DIRECTORY, which `Bun.file().exists()` answers false for; `lstatSync`
// also sees a dangling symlink, which `Bun.write` would write through.
import { existsSync, lstatSync } from 'node:fs';
// why: Bun ships no path API; `dirname`/`join` place the sibling the fix names.
import { dirname, join } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import { appNameIssue } from './app-name';
import { msg } from './messages';
import type { CommandResult } from './output';
import { quoteArg } from './shell-quote';

/** How far `-2`, `-3`, … is walked before the fix falls back to a placeholder. */
const SUFFIX_LIMIT = 100;

/**
 * The first `<slug>-<n>` beside `target` that is not on disk and that core's `defineConfig`
 * accepts — a free name, so the fix cannot land on a second existing directory.
 */
export function freeSibling(target: string, slug: string): string | undefined {
  for (let n = 2; n <= SUFFIX_LIMIT; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${slug.slice(0, 64 - suffix.length)}${suffix}`;
    if (appNameIssue(candidate) !== undefined) continue;
    if (!existsSync(join(dirname(target), candidate))) return candidate;
  }
  return undefined;
}

export interface NewTarget {
  readonly target: string;
  readonly slug: string;
  readonly force: boolean;
  /** `invocationOf(ctx, 'new')`: `x new` or `bunx create-ultimate`. */
  readonly invocation: string;
  /** The caller's flags as `reproducedFlags` spells them; `--force` is dropped here. */
  readonly flags: readonly string[];
  /** `planNewApp`'s paths, relative to `target`: what `--force` would write. */
  readonly planned: readonly string[];
}

/** How many colliding paths the cause spells out before it counts the rest. */
const LISTED_COLLISIONS = 5;

/**
 * The planned paths `--force` would overwrite: the path itself on disk (file, directory or link),
 * or one of its parent segments on disk as something other than a directory.
 */
export function collisions(target: string, planned: readonly string[]): readonly string[] {
  const hit = new Set<string>();
  for (const path of planned) {
    const segments = path.split('/');
    for (let i = 1; i <= segments.length; i += 1) {
      const prefix = segments.slice(0, i).join('/');
      const stat = lstatSync(join(target, prefix), { throwIfNoEntry: false });
      if (stat === undefined) break;
      if (i === segments.length || !stat.isDirectory()) {
        hit.add(prefix);
        break;
      }
    }
  }
  return [...hit].sort();
}

const listed = (paths: readonly string[]): string => {
  const head = paths.slice(0, LISTED_COLLISIONS).join(', ');
  const rest = paths.length - LISTED_COLLISIONS;
  return rest > 0 ? `${head} and ${rest} more` : head;
};

/**
 * The refusal of an existing target, before a byte is written — `undefined` when the run may go on.
 * `--force` lifts it only for a directory that holds no `app.config.ts` and none of the planned
 * paths — a fresh clone the platform scaffolds into (`.git`, a `LICENSE`). Over an app it would
 * reset every file the template also writes; over a monorepo root, its `package.json` and
 * `README.md`. A result, not a throw, so the summary says which it was.
 */
export function targetConflict(input: NewTarget): CommandResult | undefined {
  const { target, slug, force, invocation, flags } = input;
  if (!existsSync(target)) return undefined;
  const holdsApp = existsSync(join(target, 'app.config.ts'));
  const taken = force && !holdsApp ? collisions(target, input.planned) : [];
  if (force && !holdsApp && taken.length === 0) return undefined;
  return {
    ok: false,
    command: 'new',
    summary: holdsApp
      ? msg('cli.new.existsApp', { dir: target })
      : taken.length > 0
        ? msg('cli.new.existsFiles', { dir: target, count: taken.length })
        : msg('cli.new.exists', { dir: target }),
    findings: [
      {
        code: 'X_GENERATE_CONFLICT',
        cause: holdsApp
          ? `${target} already exists and holds an app (app.config.ts): scaffolding into it, --force included, would reset its registrations and grants to the template, so x new refuses it`
          : taken.length > 0
            ? `${target} already holds ${taken.length} path(s) x new would write: ${listed(taken)}. --force writes only into free paths, so nothing was written — move each aside (mv -n ${quoteArg(taken[0] ?? '')} ${quoteArg(`${taken[0] ?? ''}.orig`)}, …) and run with --force again to scaffold here, or take a free name for a fresh app`
            : `${target} already exists and holds no app.config.ts — --force writes the scaffold into it only when none of its paths are taken, a free name writes a fresh app`,
        fix: [
          invocation,
          quoteArg(freeSibling(target, slug) ?? '<another-name>'),
          ...flags.filter((flag) => flag !== '--force'),
        ].join(' '),
        docs: ERROR_DOCS_URL,
        at: target,
      },
    ],
  };
}
