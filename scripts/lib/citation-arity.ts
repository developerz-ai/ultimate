// How many bare words an `x <command>` citation may carry, judged against the usage line the
// registry declares and `x help` prints. `citationFault` reads three words and judges a positional
// only where a CLOSED set is declared, so `x routes list --json` resolved clean while `x routes`
// takes no positional at all — the retired spelling the route-miss fix lines shipped.

import type { CitationFault, CommandCatalog } from '../../packages/cli/src/fix-command';
import type { CommandSpec } from '../../packages/cli/src/parse';
import { GLOBAL_FLAGS } from '../../packages/cli/src/parse';

/** One positional slot: a closed set of words, any word, or any number of them. */
export interface Slot {
  readonly literals?: readonly string[];
  readonly variadic?: true;
}
export interface Form {
  readonly slots: readonly Slot[];
}

type Token = { readonly kind: 'word' | 'quoted'; readonly text: string } | Group;
interface Group {
  readonly kind: 'group';
  readonly tokens: readonly Token[];
  /** Its alternatives: inside `[…]` a `|` separates them even unspaced — `[explain <CODE>|list]`. */
  readonly options: readonly (readonly Token[])[];
}

/** `text` split on every `|` outside a nested `[…]` or a `"…"`. */
const splitPipes = (text: string): readonly string[] => {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === '[') depth += 1;
    else if (!quoted && char === ']') depth -= 1;
    else if (!quoted && depth === 0 && char === '|') {
      parts.push(text.slice(start, at));
      start = at + 1;
    }
  }
  return [...parts, text.slice(start)];
};

/** Words, `"…"` runs and `[…]` groups, nested. A `[` inside a word (`path[,path…]`) stays in it. */
function tokenize(text: string): readonly Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const closeOf = (open: number): number => {
    let depth = 0;
    for (let at = open; at < text.length; at += 1) {
      if (text[at] === '[') depth += 1;
      else if (text[at] === ']' && --depth === 0) return at;
    }
    return text.length;
  };
  while (index < text.length) {
    const char = text[index] as string;
    if (/\s/.test(char)) index += 1;
    else if (char === '[') {
      const close = closeOf(index);
      const inner = text.slice(index + 1, close);
      tokens.push({
        kind: 'group',
        tokens: tokenize(inner),
        options: splitPipes(inner).map(tokenize),
      });
      index = close + 1;
    } else if (char === '"') {
      const close = text.indexOf('"', index + 1);
      const end = close === -1 ? text.length : close;
      tokens.push({ kind: 'quoted', text: text.slice(index + 1, end) });
      index = end + 1;
    } else {
      let end = index;
      while (end < text.length && !/\s/.test(text[end] as string)) {
        end = text[end] === '[' ? closeOf(end) + 1 : end + 1;
      }
      tokens.push({ kind: 'word', text: text.slice(index, end) });
      index = end;
    }
  }
  return tokens;
}

/** Split at a standalone `|` or `·` — alternative invocations, never a choice word (`a|b`). */
const alternatives = (tokens: readonly Token[]): readonly (readonly Token[])[] => {
  const out: Token[][] = [[]];
  for (const token of tokens) {
    if (token.kind === 'word' && (token.text === '|' || token.text === '·')) out.push([]);
    else out.at(-1)?.push(token);
  }
  return out;
};

const flagType = (spec: CommandSpec, word: string): string | undefined => {
  const name = word.replace(/^--?(?:no-)?/, '').split('=')[0];
  return [...GLOBAL_FLAGS, ...(spec.flags ?? [])].find((flag) => flag.name === name)?.type;
};

/** Words the spec itself names as a subcommand or a closed positional — everything else is open. */
const closedWords = (spec: CommandSpec): ReadonlySet<string> =>
  new Set([
    ...(spec.subcommands ?? []),
    ...(spec.positionalChoices ?? []),
    ...Object.values(spec.subcommandPositionals ?? {}).flat(),
  ]);

function formsOf(tokens: readonly Token[], spec: CommandSpec): readonly (readonly Slot[])[] {
  let forms: (readonly Slot[])[] = [[]];
  const closed = closedWords(spec);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    if (token.kind === 'word' && token.text.startsWith('-')) {
      const next = tokens[index + 1];
      const valued = !token.text.includes('=') && next !== undefined && next.kind !== 'group';
      const typed = flagType(spec, token.text);
      const placeholder =
        next?.kind === 'quoted' || (next?.kind === 'word' && next.text.startsWith('<'));
      if (
        valued &&
        !next.text.startsWith('-') &&
        (typed === 'string' || (typed === undefined && placeholder))
      ) {
        index += 1;
      }
      continue;
    }
    if (token.kind === 'group') {
      const first = token.tokens[0];
      if (first?.kind === 'word' && first.text.startsWith('-')) continue;
      const options = token.options.flatMap((one) => formsOf(one, spec));
      forms = forms.flatMap((form) => [form, ...options.map((option) => [...form, ...option])]);
      continue;
    }
    const text = token.text;
    const slot: Slot =
      token.kind === 'quoted' || text.startsWith('<')
        ? text.includes('…')
          ? { variadic: true }
          : {}
        : text.includes('|')
          ? { literals: text.split('|') }
          : closed.has(text)
            ? { literals: [text] }
            : {};
    forms = forms.map((form) => [...form, slot]);
  }
  return forms;
}

/** Every positional shape the usage line allows, a bare default subcommand spelled both ways. */
export function usageForms(spec: CommandSpec): readonly Form[] {
  const subcommands = spec.subcommands ?? [];
  return alternatives(tokenize(spec.usage)).flatMap((alternative) => {
    const head = alternative[0];
    const named = head?.kind === 'word' && head.text === 'x' ? alternative.slice(2) : alternative;
    return formsOf(named, spec).flatMap((slots) => {
      const first = slots[0]?.literals?.[0];
      const bare = spec.defaultSubcommand !== undefined && !subcommands.includes(first ?? '');
      return bare
        ? [{ slots }, { slots: [{ literals: [spec.defaultSubcommand as string] }, ...slots] }]
        : [{ slots }];
    });
  });
}

const CITATION = /(?:^|[\s;|&("'`])x\s+([a-z][a-z\d-]*(?::[a-z][a-z\d-]*)?)/g;
/** Where the shell words end: an operator, a comment, a closing quote or backtick. */
const ARGUMENT_END = /[;|&#`'"]/;

/**
 * The positional words the first `x <command>` citation passes: the bare words BEFORE its first
 * flag. A doc line writes positionals first and then hands the reader prose — `x routes --json
 * lists them` — so a word after a flag is not judged. A `<placeholder with spaces>` is one word, and
 * a `[` (usage syntax), a redirect, a `--` tail or a dash ends the invocation; so does prose
 * punctuation, after the word it is glued to.
 */
export function citationWords(fix: string, command: string): readonly string[] {
  const matches = [...fix.matchAll(CITATION)];
  const at = matches.findIndex((match) => match[1] === command);
  const match = matches[at];
  if (match === undefined) return [];
  const tail = fix.slice(match.index + match[0].length, matches[at + 1]?.index ?? fix.length);
  const stop = ARGUMENT_END.exec(tail)?.index;
  const span = (stop === undefined ? tail : tail.slice(0, stop)).replace(/<[^>]*>/g, (one) =>
    one.replace(/\s+/g, '_'),
  );
  const out: string[] = [];
  for (const raw of span.split(/\s+/).filter(Boolean)) {
    if (/^(?:-|\[|—|\d?>)/.test(raw)) break;
    const word = raw.replace(/[,.:;)!?]+$/, '');
    if (word !== '') out.push(word);
    if (word !== raw) break;
  }
  return out;
}

/** `…` stands for words the line elides, so the count it is part of cannot be judged. */
const ELIDED = /^(?:…|\.\.\.)$/;

const fits = (form: Form, words: readonly string[]): boolean =>
  words.every((word, index) => {
    const slot =
      form.slots[index] ?? (form.slots.at(-1)?.variadic === true ? form.slots.at(-1) : undefined);
    if (slot === undefined) return false;
    return slot.literals === undefined || slot.literals.includes(word) || word.startsWith('<');
  });

/** The first citation in `fix` passing more bare words than its command's usage line allows. */
export function arityFault(fix: string, catalog: CommandCatalog): CitationFault | undefined {
  for (const match of fix.matchAll(CITATION)) {
    const command = match[1] as string;
    const spec = catalog.specs.find(
      (one) => one.name === command || one.aliases?.includes(command),
    );
    if (spec === undefined || catalog.planned.has(spec.name) || spec.usage.trim() === '') continue;
    const words = citationWords(fix.slice(match.index), command);
    if (words.some((word) => ELIDED.test(word))) continue;
    const forms = usageForms(spec);
    const viaDefault =
      spec.defaultSubcommandTakesPositional === true &&
      spec.defaultSubcommand !== undefined &&
      words[0] !== undefined &&
      !(spec.subcommands ?? []).includes(words[0]);
    const candidates = viaDefault ? [words, [spec.defaultSubcommand as string, ...words]] : [words];
    if (candidates.some((one) => forms.some((form) => fits(form, one)))) continue;
    const most = Math.max(...forms.map((form) => form.slots.length));
    return {
      subject: `x ${command} ${words.join(' ')}`,
      reason:
        most === 0
          ? `and ${command} takes no positional word (usage: ${spec.usage})`
          : `and no form of ${command} takes these ${words.length} positional word(s) (usage: ${spec.usage})`,
    };
  }
  return undefined;
}
