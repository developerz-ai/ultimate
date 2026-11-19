// Single responsibility: what one migration's `up` does to named schema objects, as far as the fork
// detector has to know. Read off the token stream `rolling.ts` already owns, so comments, literals
// and dollar bodies never read as DDL and no second tokenizer exists.

import { REBUILDABLE_DROP_CLAUSES } from './destructive';
import { alteredTable, isWord, nameOf, qualifiedNameAt, subcommands, tokensOf } from './rolling';
import { statementsOf } from './statement-split';

export type ForkEvent =
  | { readonly op: 'create-table'; readonly table: string; readonly guarded: boolean }
  | { readonly op: 'drop-table'; readonly table: string }
  | { readonly op: 'rename-table'; readonly table: string; readonly to: string }
  | {
      readonly op: 'add-column';
      readonly table: string;
      readonly column: string;
      readonly guarded: boolean;
    }
  | { readonly op: 'drop-column'; readonly table: string; readonly column: string }
  | { readonly op: 'drop-constraint'; readonly table: string; readonly name: string }
  | { readonly op: 'drop-index'; readonly name: string }
  | { readonly op: 'drop-view'; readonly name: string };

/** `add <this>` opens a table constraint, never a column. */
const ADD_CONSTRAINT_WORDS = ['constraint', 'primary', 'unique', 'foreign', 'check', 'exclude'];

/** The position after `if exists` / `if not exists`, and whether one was there. */
function pastGuard(tokens: readonly string[], at: number): { at: number; guarded: boolean } {
  if (isWord(tokens[at], 'if') && isWord(tokens[at + 1], 'exists')) {
    return { at: at + 2, guarded: true };
  }
  if (
    isWord(tokens[at], 'if') &&
    isWord(tokens[at + 1], 'not') &&
    isWord(tokens[at + 2], 'exists')
  ) {
    return { at: at + 3, guarded: true };
  }
  return { at, guarded: false };
}

/** `a, "b", public.c` from `start`: `drop table` and its kin take a list. */
function namesFrom(tokens: readonly string[], start: number): readonly string[] {
  const names: string[] = [];
  let at = start;
  for (;;) {
    const named = qualifiedNameAt(tokens, at);
    if (named === undefined) return names;
    names.push(named.name);
    if (tokens[named.next] !== ',') return names;
    at = named.next + 1;
  }
}

function alterEvents(table: string, part: readonly string[]): readonly ForkEvent[] {
  const [verb, second] = part;
  if (second === undefined) return [];
  if (isWord(verb, 'add')) {
    if (ADD_CONSTRAINT_WORDS.includes(second.toLowerCase()) && !second.startsWith('"')) return [];
    const { at, guarded } = pastGuard(part, isWord(second, 'column') ? 2 : 1);
    const column = part[at];
    return column === undefined
      ? []
      : [{ op: 'add-column', table, column: nameOf(column), guarded }];
  }
  if (isWord(verb, 'drop')) {
    if (isWord(second, 'constraint')) {
      const name = part[pastGuard(part, 2).at];
      return name === undefined ? [] : [{ op: 'drop-constraint', table, name: nameOf(name) }];
    }
    if (REBUILDABLE_DROP_CLAUSES.includes(second.toLowerCase())) return [];
    const column = part[pastGuard(part, isWord(second, 'column') ? 2 : 1).at];
    return column === undefined ? [] : [{ op: 'drop-column', table, column: nameOf(column) }];
  }
  if (!isWord(verb, 'rename')) return [];
  if (isWord(second, 'to')) {
    const to = part[2];
    return to === undefined ? [] : [{ op: 'rename-table', table, to: nameOf(to) }];
  }
  if (isWord(second, 'constraint')) {
    const name = part[2];
    return name === undefined ? [] : [{ op: 'drop-constraint', table, name: nameOf(name) }];
  }
  // A renamed column leaves its old name behind; the sidecar beside it records the new one.
  const column = isWord(second, 'column') ? part[2] : second;
  return column === undefined ? [] : [{ op: 'drop-column', table, column: nameOf(column) }];
}

function dropEvents(tokens: readonly string[]): readonly ForkEvent[] {
  if (isWord(tokens[1], 'table')) {
    return namesFrom(tokens, pastGuard(tokens, 2).at).map((table) => ({ op: 'drop-table', table }));
  }
  if (isWord(tokens[1], 'index')) {
    const after = isWord(tokens[2], 'concurrently') ? 3 : 2;
    return namesFrom(tokens, pastGuard(tokens, after).at).map((name) => ({
      op: 'drop-index',
      name,
    }));
  }
  const viewAt = isWord(tokens[1], 'materialized') ? 2 : 1;
  if (!isWord(tokens[viewAt], 'view')) return [];
  return namesFrom(tokens, pastGuard(tokens, viewAt + 1).at).map((name) => ({
    op: 'drop-view',
    name,
  }));
}

function statementEvents(tokens: readonly string[]): readonly ForkEvent[] {
  if (isWord(tokens[0], 'drop')) return dropEvents(tokens);
  if (isWord(tokens[0], 'create')) {
    const tableAt = isWord(tokens[1], 'unlogged') ? 2 : 1;
    if (!isWord(tokens[tableAt], 'table')) return [];
    const { at, guarded } = pastGuard(tokens, tableAt + 1);
    const named = qualifiedNameAt(tokens, at);
    return named === undefined ? [] : [{ op: 'create-table', table: named.name, guarded }];
  }
  if (isWord(tokens[0], 'alter') && isWord(tokens[1], 'index')) {
    const { at } = pastGuard(tokens, 2);
    const named = qualifiedNameAt(tokens, at);
    return named !== undefined && isWord(tokens[named.next], 'rename')
      ? [{ op: 'drop-index', name: named.name }]
      : [];
  }
  const altered = alteredTable(tokens);
  if (altered === undefined) return [];
  return subcommands(tokens.slice(altered.next)).flatMap((part) =>
    alterEvents(altered.table, part),
  );
}

/** Every event of `up`, in apply order: a drop and a re-create in one file cancel by position. */
export const forkEventsOf = (up: string): readonly ForkEvent[] =>
  statementsOf(up).flatMap((statement) => statementEvents(tokensOf(statement)));
