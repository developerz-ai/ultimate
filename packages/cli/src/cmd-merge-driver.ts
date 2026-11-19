// `x merge-driver`: `install` writes the two git drivers into this clone, `run` is the one git
// calls for a registry both sides changed. Exit 0 is "merged"; anything else leaves the file holding
// its remaining conflict markers and git reporting it as conflicted, as for any text merge.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import { mergeDriverSpec } from './cmd-merge-driver-spec';
import type { CliCommand, CommandContext } from './command';
import { failed, ok } from './command';
import { MissingPositionalError } from './errors';
import { mergeCatalogText } from './merge-driver-catalog';
import { driverConfig, gitPrefix } from './merge-driver-config';
import { conflictsLeft, resolveAdditions } from './merge-driver-lines';
import { UNMERGED_FIX } from './merge-state';
import type { CommandResult, Finding } from './output';

const NAME = mergeDriverSpec.name;

async function install(ctx: CommandContext): Promise<CommandResult> {
  const prefix = await gitPrefix(ctx.cwd, ctx.runner);
  if (prefix === undefined) {
    return ok(NAME, 'not a git checkout: no merge drivers to install', {
      data: { installed: false },
    });
  }
  for (const [key, value] of driverConfig(prefix)) {
    const set = await ctx.runner(['git', 'config', '--local', key, value], { cwd: ctx.cwd });
    if (!set.ok) {
      return failed(NAME, `could not set ${key}`, {
        findings: [
          {
            code: 'X_MERGE_DRIVER_UNSET',
            cause: `git config refused ${key}: ${set.stderr.trim()}`,
            fix: 'bunx x merge-driver install',
            docs: ERROR_DOCS_URL,
            at: '.git/config',
          },
        ],
      });
    }
  }
  return ok(NAME, 'merge drivers installed for this clone', { data: { installed: true } });
}

const conflictFinding = (path: string, cause: string): Finding => ({
  code: 'X_MERGE_UNRESOLVED',
  cause,
  fix: UNMERGED_FIX,
  docs: ERROR_DOCS_URL,
  at: path,
});

async function run(ctx: CommandContext): Promise<CommandResult> {
  const [base, ours, theirs, path] = ctx.args.positionals;
  if (base === undefined || ours === undefined || theirs === undefined || path === undefined) {
    throw new MissingPositionalError({
      command: 'merge-driver run',
      positional: 'base> <ours> <theirs> <path',
      example: 'bunx x merge-driver install   # git passes these four itself, once installed',
    });
  }
  const text = (file: string): Promise<string> => Bun.file(file).text();
  if (path.endsWith('.json')) {
    const merged = mergeCatalogText(await text(base), await text(ours), await text(theirs));
    if (merged !== undefined) {
      await Bun.write(ours, merged);
      return ok(NAME, `${path}: merged both sides' keys`, { data: { path, conflicts: 0 } });
    }
  }
  const labels = ['-L', 'ours', '-L', 'base', '-L', 'theirs'];
  const argv = ['git', 'merge-file', '-p', '--diff3', ...labels, ours, base, theirs];
  const merge = await ctx.runner(argv, { cwd: ctx.cwd });
  // A positive exit is how many conflicts it left; git's own failures are negative, so 255 here.
  if (merge.code < 0 || merge.code > 127) {
    return failed(NAME, `${path}: git merge-file failed`, {
      findings: [conflictFinding(path, `git merge-file refused ${path}: ${merge.stderr.trim()}`)],
    });
  }
  const resolved = path.endsWith('.json')
    ? { text: merge.stdout, conflicts: merge.code }
    : resolveAdditions(merge.stdout);
  const result = resolved.text;
  // Never exit 0 over a marker: git then records a clean merge of a file that still holds one.
  const conflicts = conflictsLeft(result, resolved.conflicts, merge.code);
  await Bun.write(ours, result);
  if (conflicts === 0) {
    return ok(NAME, `${path}: merged both sides' additions`, { data: { path, conflicts } });
  }
  const cause = `${path}: both branches changed the same existing lines (${conflicts} conflict(s))`;
  return failed(NAME, cause, { findings: [conflictFinding(path, cause)] });
}

export const mergeDriverCommand: CliCommand = {
  spec: mergeDriverSpec,
  run: (ctx) => (ctx.args.subcommand === 'install' ? install(ctx) : run(ctx)),
};
