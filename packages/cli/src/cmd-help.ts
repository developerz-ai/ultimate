// `x help` — the command catalogue, generated from the same specs the parser uses, so help can
// never describe a flag that does not exist. Built as a factory over the spec list to keep the
// registry acyclic.

import { nearestName } from '@ultimat3/core';
import type { CliCommand, CommandContext } from './command';
import { UnknownCommandError } from './errors';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import type { CommandSpec, FlagSpec } from './parse';
import { GLOBAL_FLAGS } from './parse';

const flagLine = (flag: FlagSpec): string => {
  const short = flag.short === undefined ? '    ' : `-${flag.short}, `;
  const name = flag.type === 'string' ? `--${flag.name} <value>` : `--${flag.name}`;
  return `  ${short}${name.padEnd(24)} ${flag.summary}`;
};

/**
 * The one resolution of a topic, read by both renderers. `--json` filtered on `spec.name === topic`
 * of its own, so the two disagreed about exactly the inputs a caller is least sure of: `x help
 * generate --json` answered `[]` — "that command does not exist" — while the page beside it printed
 * `g`. A topic naming no command is refused, as `x <topic>` itself is: answering the catalogue
 * with exit 0 read as that command's usage to a caller that never compared the names.
 */
const specFor = (
  specs: readonly CommandSpec[],
  topic: string | undefined,
): CommandSpec | undefined => {
  if (topic === undefined) return undefined;
  const found = specs.find(
    (entry) => entry.name === topic || (entry.aliases ?? []).includes(topic),
  );
  if (found !== undefined) return found;
  const names = specs.map((entry) => entry.name);
  const nearest = nearestName(topic, [...names, ...specs.flatMap((entry) => entry.aliases ?? [])]);
  throw new UnknownCommandError({
    path: `help ${topic}`,
    known: names,
    suggestion: nearest === undefined ? 'help' : `help ${nearest}`,
  });
};

/** What `--json` reports: the one resolved command, or — with no topic — all of them. */
export function helpTopic(
  specs: readonly CommandSpec[],
  topic: string | undefined,
): readonly CommandSpec[] {
  const spec = specFor(specs, topic);
  return spec === undefined ? specs : [spec];
}

export function renderHelp(specs: readonly CommandSpec[], topic: string | undefined): string[] {
  const spec = specFor(specs, topic);
  if (spec === undefined) {
    // `cli.hint.help` is deliberately absent from this list: it is the command's own `summary`, and
    // `renderHuman` prints every line and THEN the summary — so the catalogue ended with the same
    // sentence twice, once bare and once marked `✓`. One string, one place that renders it.
    return [
      msg('cli.tagline'),
      '',
      msg('cli.usage'),
      '',
      msg('cli.commands.heading'),
      ...specs.map((entry) => `  ${entry.name.padEnd(10)} ${entry.summary}`),
      '',
      msg('cli.flags.heading'),
      ...GLOBAL_FLAGS.map(flagLine),
    ];
  }
  return [
    `${spec.name} — ${spec.summary}`,
    '',
    spec.usage,
    ...(spec.subcommands === undefined ? [] : ['', `subcommands: ${spec.subcommands.join(' | ')}`]),
    '',
    msg('cli.flags.heading'),
    ...[...(spec.flags ?? []), ...GLOBAL_FLAGS].map(flagLine),
  ];
}

const catalogue = (specs: readonly CommandSpec[]): JsonValue =>
  specs.map((spec) => ({
    name: spec.name,
    summary: spec.summary,
    usage: spec.usage,
    aliases: [...(spec.aliases ?? [])],
    subcommands: [...(spec.subcommands ?? [])],
    // `null` rather than absent: an agent reading this has to be able to tell "the bare form runs
    // this one" from "the bare form is refused", and a missing key reads as neither.
    defaultSubcommand: spec.defaultSubcommand ?? null,
    flags: [...(spec.flags ?? []), ...GLOBAL_FLAGS].map((flag) => ({
      name: flag.name,
      type: flag.type,
      summary: flag.summary,
    })),
  }));

export function createHelpCommand(specs: () => readonly CommandSpec[]): CliCommand {
  return {
    spec: {
      name: 'help',
      summary: 'this catalogue, or the usage for one command',
      usage: 'x help [command] [--json]',
    },
    async run(ctx: CommandContext): Promise<CommandResult> {
      const all = specs();
      const topic = ctx.args.positionals[0];
      return {
        ok: true,
        command: 'help',
        summary: msg('cli.hint.help'),
        lines: renderHelp(all, topic),
        data: catalogue(helpTopic(all, topic)),
      };
    },
  };
}

/**
 * A resolver, not a string: `registry.ts` builds `COMMANDS` at module scope, and a manifest read
 * done there runs before `main` in every process that imports `@ultimat3/cli` — including a
 * compiled `apps/web/server.ts`, which never calls this command at all. Deferring the read into
 * `run()` is what keeps that boot from depending on a `package.json` the binary does not carry.
 */
export function createVersionCommand(version: () => string): CliCommand {
  return {
    spec: { name: 'version', summary: 'the CLI version', usage: 'x version [--json]' },
    async run(): Promise<CommandResult> {
      const resolved = version();
      return {
        ok: true,
        command: 'version',
        summary: resolved,
        data: { version: resolved, bun: Bun.version },
      };
    },
  };
}
