// `x docs <question>` — the framework's documentation, answered offline from what is installed.
//
// One step, no filename known in advance, no network. An agent that has a question and no path
// should not have to guess which of 29 packages holds the answer, and it must never be handed a
// URL: `node_modules` already contains every doc, because the published artifact IS the source.

import { dirname } from 'node:path';
import type { DocEntry, DocHit } from '@ultimat3/manifest';
import { nearestTopics, scanInstalledDocs, searchDocs } from '@ultimat3/manifest';
import type { CliCommand, CommandContext } from './command';
import { MissingPositionalError } from './errors';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';

/** Matches printed by default. Enough to choose between, few enough to read all of. */
const DEFAULT_LIMIT = 5;

/**
 * The installed `@ultimat3` scope, resolved from the CLI's own dependency on `@ultimat3/core`
 * rather than from the user's cwd. That is deliberate: these are the packages THIS `x` is pinned
 * against, so the docs it quotes are the docs of the code it would run. Resolution follows the
 * symlink, so it lands on `node_modules/@ultimat3` in an app and on `packages/` in this monorepo —
 * one code path for both, and a directory listing rather than a hardcoded package list, because
 * an app installs the subset it uses.
 */
export function frameworkScopeDir(): string | undefined {
  try {
    return dirname(dirname(Bun.resolveSync('@ultimat3/core/package.json', import.meta.dir)));
  } catch {
    return undefined;
  }
}

/** An install where the CLI cannot see its own dependency is broken, not merely undocumented. */
const unresolvedFinding = (): Finding => ({
  code: 'X_CLI_UNEXPECTED',
  cause: '@ultimat3/core does not resolve from the installed CLI, so no docs could be read',
  fix: 'bun install && x doctor --json',
  docs: 'https://ultimate.dev/errors/X_CLI_UNEXPECTED',
  at: import.meta.dir,
});

const asJson = (hit: DocHit): JsonValue => ({
  topic: hit.entry.topic,
  package: hit.entry.package,
  version: hit.entry.version,
  kind: hit.entry.kind,
  title: hit.entry.title,
  text: hit.entry.text,
  symbols: [...hit.entry.symbols],
  source: hit.entry.source,
  matched: [...hit.matched],
  score: hit.score,
});

/** The exact path an agent opens next — package-relative is ambiguous across 29 packages. */
const locate = (entry: DocEntry): string => `${entry.package}/${entry.source}`;

function humanLines(hits: readonly DocHit[]): readonly string[] {
  const lines: string[] = [];
  for (const hit of hits) {
    lines.push(`  ${hit.entry.topic}  ${locate(hit.entry)}`);
    if (hit.entry.title !== '') lines.push(`    ${hit.entry.title}`);
    if (hit.entry.symbols.length > 0) {
      lines.push(`    exports: ${hit.entry.symbols.slice(0, 12).join(', ')}`);
    }
  }
  return lines;
}

/**
 * An `X_*` code is not a documentation question — `x errors explain` already answers it offline,
 * with a runnable fix, and refuses a code nobody registered. Pointing at it costs the agent one
 * step and beats ranking a code against prose that merely mentions it (axiom 1: one way).
 */
const CODE_QUERY = /\bX_[A-Z0-9_]{3,}\b/;

/**
 * A miss is still an instruction (axiom 4). Topics that half-matched come first; when nothing
 * related at all, the honest fallback is the list of packages actually installed — the universe
 * the question could have been about — rather than five topics picked for sharing letters.
 */
function missResult(query: string, entries: readonly DocEntry[]): CommandResult {
  const suggestions = nearestTopics(entries, query);
  const packages = [...new Set(entries.map((entry) => entry.package))].sort();
  const next =
    suggestions.length > 0
      ? suggestions.map((topic) => `  x docs ${topic} --json`)
      : [`  installed: ${packages.join(' ')}`];
  return {
    ok: false,
    command: 'docs',
    summary: msg('cli.docs.none', { query }),
    lines: [
      ...next,
      '  x errors list --json          # every X_* code, with its fix',
      "  x actions list --json         # this app's own primitives, not the framework's",
    ],
    data: { matches: [], suggestions: [...suggestions], packages, query },
  };
}

export const docsCommand: CliCommand = {
  spec: {
    name: 'docs',
    summary: 'the framework docs, answered offline from the installed packages',
    usage: 'x docs "<question|topic|symbol>" [--limit <n>] [--json]',
    flags: [
      { name: 'limit', type: 'string', summary: `matches to return (default: ${DEFAULT_LIMIT})` },
    ],
  },
  // `async` is load-bearing: a synchronous throw would escape every caller that awaits the
  // promise this signature promises, including the dispatcher's own error path.
  async run(ctx: CommandContext): Promise<CommandResult> {
    // Joined, not `[0]`: an unquoted question arrives as many positionals, and answering only the
    // first word is the failure an agent cannot see — it gets a plausible answer to "how".
    const query = ctx.args.positionals.join(' ').trim();
    if (query === '') {
      throw new MissingPositionalError({
        command: 'docs',
        positional: 'question',
        example: 'x docs "how does job() retry" --json',
      });
    }

    const scope = frameworkScopeDir();
    if (scope === undefined) {
      const finding = unresolvedFinding();
      return {
        ok: false,
        command: 'docs',
        summary: msg('cli.docs.unresolved'),
        findings: [finding],
        data: { matches: [], suggestions: [], query },
      };
    }

    const entries = await scanInstalledDocs(scope);
    const rawLimit = ctx.args.flags.get('limit');
    const parsed = typeof rawLimit === 'string' ? Number.parseInt(rawLimit, 10) : Number.NaN;
    const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT;
    const hits = searchDocs(entries, query, limit);
    if (hits.length === 0) return missResult(query, entries);

    const code = CODE_QUERY.exec(query)?.[0];
    const codeLine = code === undefined ? [] : [`  x errors explain ${code} --json`];
    return {
      ok: true,
      command: 'docs',
      summary: msg('cli.docs.found', { count: hits.length, query }),
      lines: [...humanLines(hits), ...codeLine],
      data: { matches: hits.map(asJson), suggestions: [], query },
    };
  },
};
