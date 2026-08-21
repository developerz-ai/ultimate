// `x affected` — the workspaces a diff forces a re-test of, closed transitively over the workspace
// graph. `x verify` runs everything, which is right for a gate and wrong for the loop an agent
// iterates in; without this command that agent invents its own scoping, and an invented one that
// misses a transitive dependent is a green checkmark on a broken repo.
//
// CLI wiring only. What a diff touches is `affected.ts`, what the workspaces are is
// `workspace-graph.ts` — the `cmd-jobs.ts` / `jobs-report.ts` split, repeated.

import { affectedScope, DEFAULT_BASE } from './affected';
import type { CliCommand, CommandContext } from './command';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { flagBool } from './parse';
import { renderTable } from './table';

const HEADER = ['workspace', 'dir'] as const;

/**
 * Every catalog row the affected surface renders — this command's four and the one `x test
 * --affected` prints when nothing is affected. One list, because the two commands are one surface
 * and a per-file list would leave whichever half nobody thought about unchecked.
 *
 * The rule it exists for: `msg()` answers `⟦key⟧` for a key the catalog lacks, which is loud in the
 * terminal and completely silent to a build, so a command can ship a summary no locale renders.
 * `cmd-affected.test.ts` holds `messages.ts` to this list.
 */
export const AFFECTED_MESSAGE_KEYS = [
  'cli.affected.count',
  'cli.affected.none',
  'cli.affected.rootWide',
  'cli.affected.dirty',
  'cli.test.affected.none',
] as const;

export const affectedCommand: CliCommand = {
  spec: {
    name: 'affected',
    summary: 'the workspaces a diff touches, and every workspace that depends on one of them',
    usage: 'x affected [--base <ref>] [--dirty] [--paths] [--json]',
    flags: [
      {
        name: 'base',
        type: 'string',
        summary: `git ref to diff against, merge-base style (default: ${DEFAULT_BASE})`,
      },
      {
        name: 'dirty',
        type: 'boolean',
        summary: 'also count uncommitted work — every agent sharing this checkout, not only yours',
      },
      { name: 'paths', type: 'boolean', summary: 'print bare directories instead of a table' },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    // The one resolver `x test --affected` narrows with, so this command reports exactly what that
    // one runs. It reads `--base` before git is spawned (a malformed ref must not cost a
    // subprocess) and takes the diff at the CHECKOUT root, which is what git prints paths against.
    const { selection, root, plan } = await affectedScope({
      runner: ctx.runner,
      cwd: ctx.cwd,
      args: ctx.args,
      command: 'affected',
    });
    const params = { base: selection.base, changed: plan.changed.length };
    const table = renderTable(
      HEADER,
      plan.workspaces.map((workspace) => [workspace.name, workspace.dir]),
    ).map((line) => `  ${line}`);
    const data: JsonValue = {
      base: selection.base,
      dirty: selection.dirty,
      root,
      changed: [...plan.changed],
      ignored: [...plan.ignored],
      rootWide: [...plan.rootWide],
      workspaces: plan.workspaces.map((workspace) => ({
        name: workspace.name,
        dir: workspace.dir,
      })),
      paths: plan.workspaces.map((workspace) => workspace.dir),
    };
    return {
      // An empty answer is a fact, not a failure: a `.md`-only diff genuinely re-checks nothing,
      // and reporting it red would fail a build for editing a doc. The count is in the summary and
      // `data.changed`/`data.ignored` say what was looked at, so "green because nothing is
      // affected" is never mistaken for "green because everything passed".
      ok: true,
      command: 'affected',
      summary:
        plan.workspaces.length === 0
          ? msg('cli.affected.none', params)
          : msg('cli.affected.count', { ...params, count: plan.workspaces.length }),
      lines: [
        ...(selection.dirty ? [msg('cli.affected.dirty')] : []),
        ...(plan.rootWide.length === 0
          ? []
          : [msg('cli.affected.rootWide', { files: plan.rootWide.join(', ') })]),
        ...(plan.workspaces.length === 0
          ? []
          : // `--paths` changes only what the human sees; `--json` carries both projections on
            // every run, so the two renderers can never state different sets.
            flagBool(ctx.args, 'paths')
            ? plan.workspaces.map((workspace) => workspace.dir)
            : table),
      ],
      data,
    };
  },
};
