// `x new`'s refusal of a target directory that already exists. Its fix names a FREE directory —
// never `--force`: a fix is pasted with no diff in front of it, and `--force` over an existing app
// reset its `api/index.ts` and `roles.ts` to the template (D1, 2026-11-16).

// why: the target is a DIRECTORY, which `Bun.file().exists()` answers false for.
import { existsSync } from 'node:fs';
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
}

/**
 * The refusal of an existing target, before a byte is written — `undefined` when the run may go on.
 * `--force` lifts it only for a directory that holds no `app.config.ts` — a fresh clone the
 * platform scaffolds into; over an app it would reset every file the template also writes, so it
 * is refused whatever the flags say. A result, not a throw, so the summary says which it was.
 */
export function targetConflict(input: NewTarget): CommandResult | undefined {
  const { target, slug, force, invocation, flags } = input;
  if (!existsSync(target)) return undefined;
  const holdsApp = existsSync(join(target, 'app.config.ts'));
  if (force && !holdsApp) return undefined;
  return {
    ok: false,
    command: 'new',
    summary: msg(holdsApp ? 'cli.new.existsApp' : 'cli.new.exists', { dir: target }),
    findings: [
      {
        code: 'X_GENERATE_CONFLICT',
        cause: holdsApp
          ? `${target} already exists and holds an app (app.config.ts): scaffolding into it, --force included, would reset its registrations and grants to the template, so x new refuses it`
          : `${target} already exists and holds no app.config.ts — --force adds the scaffold beside its files, a free name writes a fresh app`,
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
