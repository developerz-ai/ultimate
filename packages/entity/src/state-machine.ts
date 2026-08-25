// The MECHANISM half of a state machine on a column: the transition table, what a terminal state
// is, and the one legality question. The states themselves never ship — they arrive as the
// `enumerated()` set the column already declares, and nothing in this file knows what any of them
// means. An illegal transition is a defect in every business; an approval chain is not.

import { refuseColumn } from './refuse';

/**
 * Every state names the states it may move to. A MAPPED type over the union, so the exhaustiveness
 * is the compiler's: a state left out, a key that is not a state and a target that is not a state
 * are each a compile error at the declaration, and the runtime checks below are what a JS caller
 * and a table built from parsed JSON get instead.
 *
 * A state with an empty list is TERMINAL. That is the whole of the terminal concept — nothing to
 * declare, nothing to name, and no way for the framework to have an opinion about which one it is.
 */
export type TransitionTable<S extends string> = { readonly [K in S]: readonly S[] };

export interface StateMachine<S extends string = string> {
  /** The declared states, in declaration order. */
  readonly states: readonly S[];
  /**
   * A `Map`, never the table object itself: `table[from]` with a caller's string answers an
   * `Object.prototype` member, so `canMove(machine, 'constructor', …)` would read the `Object`
   * function and every guard downstream would pass. The rule `bun run proto-index` enforces.
   */
  readonly moves: ReadonlyMap<S, ReadonlySet<S>>;
  /** Derived: every state whose outgoing set is empty. */
  readonly terminal: ReadonlySet<S>;
}

/**
 * One `refuseColumn` site, five conditions, and the FIX comes from the caller — because a fix line
 * carrying a `<placeholder>` is advice, not an edit, and `refuse.test.ts` refuses one. Every caller
 * below names real states out of the set the column already declared, so each answer is pasteable.
 */
const refuse = (detail: string, fix: string): never => refuseColumn('transitions', detail, fix);

/**
 * The machine a set of states and a table describe, validated once at declaration.
 *
 * Every rule here is structural: it is about whether the table describes a machine at all, never
 * about which machine is the right one. A table missing a state cannot answer "may this row move",
 * a self-loop is a transition that transitions nothing — and under the compare-and-set the write
 * path uses it would report a move that did not happen — and a repeated target is a typo whose
 * only effect is to make the declaration read as though it meant something.
 */
export const stateMachineOf = <S extends string>(
  states: readonly S[],
  table: TransitionTable<S>,
): StateMachine<S> => {
  const declared = new Set<string>(states);
  const keys = Object.keys(table);
  const unknown = keys.filter((key) => !declared.has(key));
  if (unknown.length > 0) {
    refuse(
      `${unknown.join(', ')} ${unknown.length === 1 ? 'is not one of' : 'are not among'} the declared states: ${states.join(' | ')}`,
      `delete the ${unknown.map((key) => `"${key}"`).join(', ')} entry from transitions(), or add it to the enumerated([${states.map((state) => `'${state}'`).join(', ')}]) set on this column`,
    );
  }
  const named = new Set(keys);
  const missing = states.filter((state) => !named.has(state));
  if (missing.length > 0) {
    refuse(
      `no entry for ${missing.join(', ')} — every state needs one, and a terminal state is written as an empty list`,
      `add ${missing.map((state) => `${state}: []`).join(', ')} to transitions() — an empty list is how a state nothing leaves is written`,
    );
  }
  const moves = new Map<S, ReadonlySet<S>>();
  // `origin` and not `state`, which is the word this loop is about: `bun run secret-compare` reads
  // a NAME, and `state` is in its vocabulary because an OAuth CSRF `state` is a credential compared
  // with `===` — so a state machine, whose domain word is literally that, trips a rule written for
  // a different thing. Renaming is the honest repair; a package-wide pin would spend the rule.
  for (const origin of states) {
    // Through `Object.hasOwn` even though the keys were just checked: this is the one read of a
    // caller's object literal by a name, and the guard is what makes it a read of DATA.
    const targets: readonly string[] = Object.hasOwn(table, origin) ? table[origin] : [];
    const seen = new Set<S>();
    for (const target of targets) {
      if (!declared.has(target)) {
        refuse(
          `${origin} may move to ${target}, which is not one of: ${states.join(' | ')}`,
          `remove '${target}' from the ${origin} entry of transitions(), or add it to the enumerated([${states.map((each) => `'${each}'`).join(', ')}]) set on this column`,
        );
      }
      if (target === origin) {
        refuse(
          `${origin} lists itself as a target; a transition that changes nothing is not one`,
          `remove '${origin}' from its own entry of transitions() — write ${origin}: [] if nothing leaves it`,
        );
      }
      if (seen.has(target as S)) {
        refuse(
          `${origin} lists ${target} twice`,
          `remove the second '${target}' from the ${origin} entry of transitions()`,
        );
      }
      seen.add(target as S);
    }
    moves.set(origin, seen);
  }
  const terminal = new Set<S>(states.filter((state) => (moves.get(state)?.size ?? 0) === 0));
  return { states: [...states], moves, terminal };
};

/** Whether the machine holds this exact move. Unknown states answer `false`, never throw. */
export const canMove = <S extends string>(
  machine: StateMachine<S>,
  from: string,
  to: string,
): boolean => machine.moves.get(from as S)?.has(to as S) === true;

export const isTerminal = <S extends string>(machine: StateMachine<S>, state: string): boolean =>
  machine.terminal.has(state as S);

/**
 * Whether the machine declares this state at all — the question `isTerminal` cannot answer, and the
 * reason it is asked FIRST at the call site. An unknown state has no outgoing moves either, so
 * without this the refusal for a typo read "the row is terminal in <typo>", which is a sentence
 * about a state that does not exist.
 */
export const isState = <S extends string>(machine: StateMachine<S>, state: string): boolean =>
  machine.moves.has(state as S);

/** Everywhere this state may go, in declaration order — what a refusal lists back at the caller. */
export const movesFrom = <S extends string>(
  machine: StateMachine<S>,
  from: string,
): readonly S[] => {
  const targets = machine.moves.get(from as S);
  return targets === undefined ? [] : machine.states.filter((state) => targets.has(state));
};
