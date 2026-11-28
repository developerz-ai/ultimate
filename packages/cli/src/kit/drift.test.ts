// A kit file that names an `x` command, a flag, a dev-MCP tool or an `X_*` code this build does
// not ship is broken, not merely stale: the agent reading it runs the line and gets "no such
// command". Every reference in every managed file, resolved against the shipped registries.

import { describe, expect, test } from 'bun:test';
import type { DevHost } from '@ultimat3/mcp';
import { devTools } from '@ultimat3/mcp';
import { registeredErrorCodes } from '../error-catalog';
import { GLOBAL_FLAGS } from '../parse';
import { SPECS } from '../registry';
import { names } from '../templates/naming';
import { kitFiles } from './registry';

const app = names('ledger-demo');
const kitText = kitFiles(app).map((file) => `${file.path}\n${file.contents}`);

const WORD = /^[a-z][a-z0-9-]*$/;
const FILE_EXTENSIONS = new Set(['md', 'ts', 'tsx', 'json', 'yml', 'yaml', 'png', 'scss', 'css']);

/** Every code span and every fenced line, `# comments` dropped: where commands are written. */
export function commandSpans(text: string): readonly string[] {
  const fenced = [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].flatMap((match) =>
    (match[1] ?? '').split('\n').map((line) => line.replace(/\s#\s.*$/, '').trim()),
  );
  const prose = text.replace(/```[a-z]*\n[\s\S]*?```/g, '');
  const inline = [...prose.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? '');
  return [...fenced, ...inline].filter((span) => span.length > 0);
}

interface Invocation {
  readonly command: string;
  readonly subcommand: string | undefined;
  readonly flags: readonly string[];
}

/** Each `bunx x <command> [sub] [--flag …]` in one span. */
export function invocations(span: string): readonly Invocation[] {
  return span
    .split(/\bbunx x\s+/)
    .slice(1)
    .map((segment) => {
      const words = segment.split(/\s+/);
      const second = words[1];
      return {
        command: words[0] ?? '',
        subcommand: second !== undefined && WORD.test(second) ? second : undefined,
        flags: words.flatMap((word) => /^--([a-z][a-z0-9-]*)/.exec(word)?.[1] ?? []),
      };
    });
}

const SHIPPED = new Map(
  SPECS.filter((spec) => !spec.summary.endsWith('(planned)')).map((spec) => [spec.name, spec]),
);
const GLOBAL = new Set(GLOBAL_FLAGS.map((flag) => flag.name));

/** What is wrong with one invocation, or nothing. */
export function unresolved(call: Invocation): readonly string[] {
  if (!WORD.test(call.command)) return [];
  const spec = SHIPPED.get(call.command);
  if (spec === undefined) return [`x ${call.command}`];
  const subs = spec.subcommands ?? [];
  const problems: string[] = [];
  if (call.subcommand !== undefined && subs.length > 0 && !subs.includes(call.subcommand))
    problems.push(`x ${call.command} ${call.subcommand}`);
  const declared = new Set((spec.flags ?? []).map((flag) => flag.name));
  for (const flag of call.flags)
    if (!declared.has(flag) && !GLOBAL.has(flag)) problems.push(`x ${call.command} --${flag}`);
  return problems;
}

/** `graph.query`-shaped names: as a code span, or after "MCP" in prose or a comment. */
export function mcpToolsNamed(text: string): readonly string[] {
  const shaped = (name: string) =>
    /^[a-z]+\.[a-z][a-zA-Z]*$/.test(name) && !FILE_EXTENSIONS.has(name.split('.')[1] ?? '');
  const spans = [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? '');
  const afterMcp = [...text.matchAll(/\bMCP `?([a-z]+\.[a-zA-Z]+)/g)].map(
    (match) => match[1] ?? '',
  );
  return [...new Set([...spans, ...afterMcp].filter(shaped))];
}

const devToolNames = (): ReadonlySet<string> => {
  // The catalog is built from the host's methods without calling them: any answer will do.
  const host = new Proxy({}, { get: () => () => ({}) }) as DevHost;
  return new Set(devTools(host).map((tool) => tool.name));
};

describe('unit · the drift checks catch what they claim to', () => {
  test('an unshipped command, subcommand or flag is named', () => {
    expect(invocations('bunx x lint --json').flatMap(unresolved)).toEqual(['x lint']);
    expect(invocations('bunx x db squash').flatMap(unresolved)).toEqual(['x db squash']);
    expect(invocations('bunx x verify --sloppy').flatMap(unresolved)).toEqual([
      'x verify --sloppy',
    ]);
    expect(invocations('bunx x verify --only typecheck --json').flatMap(unresolved)).toEqual([]);
  });

  test('fenced lines lose their comments; prose outside a span is not a command', () => {
    const text = 'run bunx x lint\n```sh\nbunx x verify --json   # not --sloppy\n```\n';
    expect(commandSpans(text)).toEqual(['bunx x verify --json']);
  });

  test('a file name is not an MCP tool; a tool after "MCP" is, spanned or not', () => {
    expect(mcpToolsNamed('`status.yml`, `x.manifest.json`, `graph.query`, MCP ui.shot')).toEqual([
      'graph.query',
      'ui.shot',
    ]);
  });
});

describe('unit · every reference in a kit file resolves', () => {
  test('every x command, subcommand and flag is shipped', () => {
    const broken = kitText.flatMap((text) =>
      commandSpans(text).flatMap((span) => invocations(span).flatMap(unresolved)),
    );
    expect([...new Set(broken)]).toEqual([]);
    // Not vacuous: the kit cites many.
    expect(
      kitText.flatMap((text) => commandSpans(text).flatMap(invocations)).length,
    ).toBeGreaterThan(30);
  });

  test('every dev-MCP tool named is in the dev catalog', () => {
    const shipped = devToolNames();
    const named = kitText.flatMap(mcpToolsNamed);
    expect(named.length).toBeGreaterThan(4);
    expect([...new Set(named.filter((name) => !shipped.has(name)))]).toEqual([]);
  });

  test('every X_* code named is registered', async () => {
    const registered = await registeredErrorCodes();
    const named = [
      ...new Set(kitText.flatMap((text) => text.match(/\bX_[A-Z][A-Z0-9_]+\b/g) ?? [])),
    ];
    expect(named.length).toBeGreaterThan(3);
    expect(named.filter((code) => !registered.has(code))).toEqual([]);
  });
});
