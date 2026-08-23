// `defineIslandStates` — an island's photographable states, validated once, frozen, and knowable
// without a browser. The vocabulary it takes and hands back is `island-states.ts`; the rules it
// applies are `island-states-check.ts`. Every default a declaration leaves out is resolved HERE, so
// nothing downstream has to decide what an absent viewport or an absent theme list meant.

import { DEFAULT_NOW } from './determinism';
import {
  IslandStateDuplicateError,
  IslandStateIdInvalidError,
  IslandStateInstantInvalidError,
  IslandStateJsonInvalidError,
  IslandStateStubInvalidError,
  IslandStatesEmptyError,
  IslandStateZoneInvalidError,
} from './island-state-errors';
import type {
  IslandState,
  IslandStateDecl,
  IslandStatesDecl,
  IslandStatesManifest,
  IslandTheme,
  IslandViewport,
} from './island-states';
import {
  DEFAULT_ISLAND_VIEWPORT,
  ISLAND_SHOT_TIME_ZONE,
  ISLAND_STATES,
  ISLAND_THEMES,
  islandStatesName,
} from './island-states';
import {
  isPinnedInstant,
  isStateId,
  isStubMatch,
  isTimeZone,
  jsonFault,
  slugifyStateId,
} from './island-states-check';

/** A dimension a browser can be sized to. Anything else inherits, rather than photographing 0px. */
const usableViewport = (viewport: IslandViewport | undefined): IslandViewport | undefined =>
  viewport !== undefined &&
  Number.isInteger(viewport.width) &&
  Number.isInteger(viewport.height) &&
  viewport.width > 0 &&
  viewport.height > 0
    ? { width: viewport.width, height: viewport.height }
    : undefined;

/**
 * Declared themes, deduplicated, in declaration order — both when the list is absent, and both
 * again when nothing in it is a theme this framework knows. Falling back rather than throwing is
 * the same rule `parseIslandAddress` follows: an unreadable theme must still show the component.
 */
const usableThemes = (themes: readonly IslandTheme[] | undefined): readonly IslandTheme[] => {
  const known = (themes ?? []).filter((theme) => ISLAND_THEMES.includes(theme));
  const unique = [...new Set(known)];
  return unique.length > 0 ? unique : ISLAND_THEMES;
};

/** Frozen all the way down: a harness that mutated props would poison every later picture. */
function freezeJson<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const entry of Object.values(value)) freezeJson(entry);
  return Object.freeze(value);
}

function checkClock(decl: IslandStatesDecl): void {
  if (decl.timeZone !== undefined && !isTimeZone(decl.timeZone)) {
    throw new IslandStateZoneInvalidError({ island: decl.island, value: decl.timeZone });
  }
  if (decl.now !== undefined && !isPinnedInstant(decl.now)) {
    throw new IslandStateInstantInvalidError({ island: decl.island, value: decl.now });
  }
}

function normalizeState(
  decl: IslandStatesDecl,
  state: IslandStateDecl,
  seen: Set<string>,
  inherited: IslandViewport,
): IslandState {
  if (!isStateId(state.id)) {
    throw new IslandStateIdInvalidError({
      island: decl.island,
      id: state.id,
      slug: slugifyStateId(state.id),
    });
  }
  if (seen.has(state.id))
    throw new IslandStateDuplicateError({ island: decl.island, id: state.id });
  seen.add(state.id);

  const propsFault = jsonFault(state.props, `state "${state.id}" props`);
  if (propsFault !== undefined) {
    throw new IslandStateJsonInvalidError({ island: decl.island, ...propsFault });
  }

  const routes = state.routes ?? [];
  for (const [index, stub] of routes.entries()) {
    if (!isStubMatch(stub.match)) {
      throw new IslandStateStubInvalidError({ island: decl.island, match: stub.match });
    }
    if (stub.respond.kind !== 'json') continue;
    const bodyFault = jsonFault(
      stub.respond.body,
      `state "${state.id}" routes[${index}].respond.body`,
    );
    if (bodyFault !== undefined) {
      throw new IslandStateJsonInvalidError({ island: decl.island, ...bodyFault });
    }
  }

  return {
    id: state.id,
    title: state.title,
    ...(state.note === undefined ? {} : { note: state.note }),
    props: state.props,
    routes,
    viewport: usableViewport(state.viewport) ?? inherited,
    themes: usableThemes(state.themes),
  };
}

/**
 * Declare the states one island can be photographed in. Validated here rather than by the command
 * that takes the pictures, because a manifest that is only checked at capture time is a manifest
 * whose defects are found by a browser — long after the file that has to change was in view.
 */
export function defineIslandStates(decl: IslandStatesDecl): IslandStatesManifest {
  if (decl.states.length === 0) throw new IslandStatesEmptyError({ island: decl.island });
  checkClock(decl);
  const viewport = usableViewport(decl.viewport) ?? DEFAULT_ISLAND_VIEWPORT;
  const seen = new Set<string>();
  const states = decl.states.map((state) => normalizeState(decl, state, seen, viewport));
  return freezeJson({
    [ISLAND_STATES]: true,
    name: islandStatesName(decl.island),
    island: decl.island,
    states,
    viewport,
    ...(decl.target === undefined ? {} : { target: decl.target }),
    timeZone: decl.timeZone ?? ISLAND_SHOT_TIME_ZONE,
    now: decl.now ?? DEFAULT_NOW,
  });
}
