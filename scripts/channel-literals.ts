#!/usr/bin/env bun
// Enforce, as a build error, that a channel topic is spelled in ONE place: the `channel(name, …)`
// declaration in `packages/realtime/src/channel.ts`, whose params builder is the only way to turn a
// declaration into a topic. A string topic handed to `subscribe('posts:' + id)` is a second naming
// rule — the server publishes on one spelling, the client listens on another, and the frames that
// should update a record arrive nowhere, with no error on either side.
//
// WHAT IT REPORTS, in shipped source and both tracked apps (tests are fixtures, never reported):
//   - `literal`: a string or template literal as the FIRST argument of a channel call —
//     `useChannel`, `publishRecords`, `subscribe`, `unsubscribe`, `publish` (bare or as a method);
//   - `built`: a topic assembled by concatenation — a first argument joining a literal with `+`, or
//     a `const`/`let` NAMED for a topic or channel initialised from a `${…}` template or a `+` join.
// A first argument that is a declaration, a call or a plain identifier is never reported: that is
// what passing a channel looks like. `channel('posts', …)` itself is the declaration and is exempt.
//
//   bun run scripts/channel-literals.ts [--json]

import { maskLiterals, stripComments } from '@ultimat3/core';
import { APP_ROOTS } from './boundaries';
import { parseScriptArgs } from './lib/args';
import { balancedClose, topLevelArguments } from './lib/balanced-paren';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { isTestPath, lineOf } from './lib/source-scan';

const SCRIPT = 'channel-literals';

/** The one module that may turn a name and params into a topic string. */
export const CHANNEL_SEAM = 'packages/realtime/src/channel.ts';

export type ChannelLiteralKind = 'literal' | 'built';

export interface ChannelLiteral {
  readonly file: string;
  readonly line: number;
  readonly kind: ChannelLiteralKind;
  /** The call or binding that carried it, so the finding quotes what the reader will search for. */
  readonly via: string;
}

const CALL = /(?<![\w$])(useChannel|publishRecords|subscribe|unsubscribe|publish)\s*\(/g;
/**
 * `const postTopic = …` — a DECLARATION whose name says it holds a topic. Not an object property:
 * `topic:` in `packages/manifest/src/docs-scan.ts` names a documentation topic, measured, and a
 * property rule reported it — a rule whose first finding is wrong is a rule readers switch off.
 */
const NAMED_BINDING =
  /\b(?:const|let|var)\s+([\w$]*(?:topic|channel)[\w$]*)\s*(?::[^=\n]+)?=(?!=)\s*/gi;
const QUOTE = /^\s*[`'"]/;

/**
 * Joined with `+`, or a template carrying a `${…}` substitution. The `+` is looked for in the
 * MASKED text — a `+` inside a string is a character, not a join — and the template in the real one.
 */
const isBuilt = (text: string, masked: string): boolean =>
  /^\s*`[^`]*\$\{/.test(text) || topLevelJoin(masked);

/**
 * A `+` at depth 0 of an expression that is not a function. `store.subscribe((c) => { n + 1 })` is
 * a listener, and the `+` in its body joins nothing into a topic — measured, on
 * `packages/realtime/src/use-record.ts`, the first draft's only false positive.
 */
function topLevelJoin(masked: string): boolean {
  let depth = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (depth === 0 && char === '=' && masked[index + 1] === '>') return false;
    else if (depth === 0 && char === '+') {
      const pair = `${masked[index - 1] ?? ''}${masked[index + 1] ?? ''}`;
      if (!pair.includes('+') && masked[index + 1] !== '=') return true;
    }
  }
  return false;
}

/** The same span read twice: once as written, once with every string blanked. */
const firstOf = (text: string, masked: string): { text: string; masked: string } => {
  const first = topLevelArguments(masked)[0] ?? '';
  const lead = masked.length - masked.trimStart().length;
  return { text: text.slice(lead, lead + first.length), masked: first };
};

export function channelLiterals(file: string, source: string): readonly ChannelLiteral[] {
  if (file === CHANNEL_SEAM || isTestPath(file)) return [];
  const text = stripComments(source);
  const masked = maskLiterals(source);
  const found: ChannelLiteral[] = [];
  for (const call of masked.matchAll(CALL)) {
    const open = call.index + call[0].length - 1;
    const close = balancedClose(masked, open);
    if (close < 0) continue;
    const first = firstOf(text.slice(open + 1, close), masked.slice(open + 1, close));
    const via = `${call[1] ?? ''}(`;
    const line = lineOf(masked, call.index);
    if (isBuilt(first.text, first.masked)) found.push({ file, line, kind: 'built', via });
    else if (QUOTE.test(first.masked)) found.push({ file, line, kind: 'literal', via });
  }
  for (const binding of masked.matchAll(NAMED_BINDING)) {
    const start = binding.index + binding[0].length;
    const end = start + (masked.slice(start).search(/[;\n]/) + 1 || masked.length - start + 1) - 1;
    const first = firstOf(text.slice(start, end), masked.slice(start, end));
    if (!isBuilt(first.text, first.masked)) continue;
    found.push({ file, line: lineOf(masked, start), kind: 'built', via: binding[1] ?? '' });
  }
  return found.sort((a, b) => a.line - b.line);
}

export function channelFinding(site: ChannelLiteral): Finding {
  const what =
    site.kind === 'literal'
      ? `passes a string topic to ${site.via}`
      : `builds a topic by concatenation in ${site.via}`;
  return {
    code: 'X_CHANNEL_LITERAL',
    at: `${site.file}:${site.line}`,
    cause: `${site.file}:${site.line} ${what}; a topic is spelled once, by a channel() declaration in ${CHANNEL_SEAM}, or the publisher and the subscriber drift onto two spellings`,
    fix: `edit ${site.file}:${site.line} — declare it once with channel(name, { params, policy }) from '@ultimat3/realtime' and pass the declaration: useChannel(decl, params) / publishRecords(decl, params, entity, rows); re-read the tree with: bun run channel-literals --json`,
  };
}

export interface SourceText {
  readonly path: string;
  readonly source: string;
}

export function channelResult(files: readonly SourceText[]): ScriptResult {
  const sites = files.flatMap((file) => channelLiterals(file.path, file.source));
  const findings = sites.map(channelFinding);
  if (!files.some((file) => file.path === CHANNEL_SEAM)) {
    findings.unshift({
      code: 'X_CHANNEL_LITERAL_UNSCANNED',
      at: 'scripts/channel-literals.ts',
      cause: `${CHANNEL_SEAM} was not among the files scanned, so the exemption names nothing and a clean run proves nothing`,
      fix: 'edit CHANNEL_SEAM in scripts/channel-literals.ts to name the module that declares channel(), then: bun run channel-literals --json',
    });
  }
  return {
    ok: findings.length === 0,
    script: SCRIPT,
    summary:
      findings.length === 0
        ? `${files.length} files, every topic spelled by ${CHANNEL_SEAM}`
        : `${findings.length} channel topic finding(s)`,
    findings,
    data: { files: files.length, sites },
  };
}

const GLOBS = ['packages/*/src/**/*.{ts,tsx}', `${APP_ROOTS}/*/**/*.{ts,tsx}`];
const NOT_SOURCE = /(?:^|\/)(?:node_modules|dist|\.x)\//;

export async function readChannelSources(root: string): Promise<readonly SourceText[]> {
  const files: SourceText[] = [];
  for (const glob of GLOBS) {
    for await (const path of new Bun.Glob(glob).scan({ cwd: root })) {
      const posix = path.split('\\').join('/');
      if (NOT_SOURCE.test(posix) || isTestPath(posix)) continue;
      files.push({ path: posix, source: await Bun.file(`${root}/${posix}`).text() });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  report(channelResult(await readChannelSources(repoRoot())), args.json);
}
