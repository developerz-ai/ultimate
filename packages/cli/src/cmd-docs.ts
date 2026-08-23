// `x docs <question>` — the framework's documentation, answered offline from what is installed.
//
// One step, no filename known in advance, no network. An agent that has a question and no path
// should not have to guess which of 29 packages holds the answer, and it must never be handed a
// URL: `node_modules` already contains every doc, because the published artifact IS the source.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { DocEntry, DocHit } from '@ultimat3/manifest';
import { nearestTopics, scanInstalledDocs, searchDocs } from '@ultimat3/manifest';
import type { CliCommand, CommandContext } from './command';
import { MissingPositionalError } from './errors';
import { frameworkScopeDir } from './framework-scope';
import { parseLimitFlag } from './jobs-report';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import { flagString } from './parse';

/** Matches printed by default. Enough to choose between, few enough to read all of. */
const DEFAULT_LIMIT = 5;

/** An install where the CLI cannot see its own dependency is broken, not merely undocumented. */
const unresolvedFinding = (): Finding => ({
  code: 'X_CLI_UNEXPECTED',
  cause: '@ultimat3/core does not resolve from the installed CLI, so no docs could be read',
  fix: 'bun install && x doctor --json',
  docs: ERROR_DOCS_URL,
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
    // The title is the package's own header comment, quoted verbatim — source text, not this
    // command's prose, so it never goes through the catalog.
    if (hit.entry.title !== '') lines.push(`    ${hit.entry.title}`);
    if (hit.entry.symbols.length > 0) {
      lines.push(
        `    ${msg('cli.docs.exports', { list: hit.entry.symbols.slice(0, 12).join(', ') })}`,
      );
    }
  }
  return lines;
}

/**
 * The two commands that answer what `x docs` does not. The invocation stays inline and only its
 * explanation is translated: a `fix:`-style command is copied and run verbatim, and a translated
 * `x errors list --json` is a broken command (the same reason `Finding.fix` is exempt).
 */
const alsoTry = (): readonly string[] => [
  `  x errors list --json          # ${msg('cli.docs.tryErrors')}`,
  `  x actions list --json         # ${msg('cli.docs.tryActions')}`,
];

/**
 * An `X_*` code is not a documentation question — `x errors explain` already answers it offline,
 * with a runnable fix, and refuses a code nobody registered. Pointing at it costs the agent one
 * step and beats ranking a code against prose that merely mentions it (axiom 1: one way).
 */
const CODE_QUERY = /\bX_[A-Z0-9_]{3,}\b/;

/**
 * Answered before anything is scanned, because the contract above is only true if nothing else
 * runs. Ranking a code against prose returned five files for `X_DB_DRIFT` that merely contain
 * "db" and "drift", with the redirect buried under them — and a code that matched nothing at all
 * fell into `missResult`, which never carried the redirect. Returning here closes both, and skips
 * a scan of every installed package for a question that was never about documentation.
 */
function codeResult(code: string, query: string): CommandResult {
  return {
    ok: true,
    command: 'docs',
    summary: msg('cli.docs.code', { code }),
    lines: [`  x errors explain ${code} --json`],
    data: { matches: [], suggestions: [], redirect: code, query },
  };
}

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
      : [`  ${msg('cli.docs.installed', { list: packages.join(' ') })}`];
  return {
    ok: false,
    command: 'docs',
    summary: msg('cli.docs.none', { query }),
    lines: [...next, ...alsoTry()],
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

    const code = CODE_QUERY.exec(query)?.[0];
    if (code !== undefined) return codeResult(code, query);

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
    // `x jobs ls --limit`'s reader, and its `command` parameter exists for exactly this second
    // caller. A local `Number.parseInt` accepted `--limit 1e9` as 1 and answered with one match,
    // and fell silently through to the default for `abc`, `0` and `-3` — a bound other than the one
    // typed, from the same binary that refuses all four one command over.
    const limit = parseLimitFlag(flagString(ctx.args, 'limit'), 'docs') ?? DEFAULT_LIMIT;
    const hits = searchDocs(entries, query, limit);
    if (hits.length === 0) return missResult(query, entries);

    return {
      ok: true,
      command: 'docs',
      summary: msg('cli.docs.found', { count: hits.length, query }),
      lines: [...humanLines(hits)],
      data: { matches: hits.map(asJson), suggestions: [], query },
    };
  },
};
