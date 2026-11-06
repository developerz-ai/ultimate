// `x impact <file|primitive|entity>` — what an edit reaches, before it is made: routes, actions,
// queries, jobs, MCP tools, published operations, tests and budgets, each with the provenance of
// the edges that reached it. The question an agent asks before an edit, answered in one call.

// why: Bun ships no path API; a path argument is relative to where the command ran.
import { join } from 'node:path';
import type { Impact, ImpactEntry } from '@ultimat3/manifest';
import { impactOf } from '@ultimat3/manifest';
import { requireAppRoot } from './app-root';
import { loadAppGraph, resolveNode } from './cmd-graph-load';
import { impactSpec } from './cmd-impact-spec';
import type { CliCommand, CommandContext } from './command';
import { MissingPositionalError } from './errors';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { posixRelative } from './posix-path';

const SECTIONS = ['routes', 'actions', 'queries', 'jobs', 'mcpTools', 'tests', 'budgets'] as const;

const names = (entries: readonly ImpactEntry[]): string =>
  entries.map((entry) => `${entry.name} [${entry.provenance.join('+')}]`).join(', ');

const render = (impact: Impact): readonly string[] => [
  ...(impact.publishedOperations.length === 0
    ? []
    : [msg('cli.impact.published', { operations: names(impact.publishedOperations) })]),
  ...SECTIONS.filter((section) => impact[section].length > 0).map((section) =>
    msg('cli.impact.section', { section, names: names(impact[section]) }),
  ),
];

export const impactCommand: CliCommand = {
  spec: impactSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('impact', ctx.cwd).dir;
    const asked = ctx.args.positionals[0];
    if (asked === undefined) {
      throw new MissingPositionalError({
        command: 'impact',
        positional: 'file|primitive|entity',
        example: 'x impact apps/web/app/posts/queries/post-by-id.ts --json',
      });
    }
    const { graph } = await loadAppGraph(root);
    // A path is read from where the command ran, and the graph keys files from the app root.
    const onDisk = join(ctx.cwd, asked);
    const named = (await Bun.file(onDisk).exists()) ? posixRelative(root, onDisk) : asked;
    const impact = impactOf(graph, resolveNode(graph, named));
    return {
      ok: true,
      command: 'impact',
      summary: msg('cli.impact.summary', {
        node: impact.node,
        routes: impact.routes.length,
        actions: impact.actions.length,
        queries: impact.queries.length,
        jobs: impact.jobs.length,
        tests: impact.tests.length,
      }),
      lines: render(impact),
      data: JSON.parse(JSON.stringify(impact)) as JsonValue,
    };
  },
};
