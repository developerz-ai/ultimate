// island-without-states: every island declares the states it can be photographed in.
// `x verify` discovers every file in `guards/` and runs its `guard` inside the `boundaries`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = 'X_ISLAND_WITHOUT_STATES';

const ISLAND_SUFFIX = '.island.tsx';
const STATES_SUFFIX = '.island.states.ts';

/** The one file that answers for an island, derived rather than searched for. */
export const statesPathFor = (island: string): string =>
  `${island.slice(0, -ISLAND_SUFFIX.length)}${STATES_SUFFIX}`;

/** `apps/web/app/post/post-form.island.tsx` → `post-form`: what `x shot --island` is given. */
const islandName = (island: string): string => {
  const base = island.split('/').pop() ?? island;
  return (base.split('.')[0] ?? base).toLowerCase();
};

/**
 * Pure — the caller does the I/O — so the rule is testable without a filesystem. Both lists come
 * out of one directory walk, which is what keeps the answer to "is there a states file" a set
 * lookup rather than a second stat per island.
 */
export function islandsWithoutStates(
  islands: readonly string[],
  states: readonly string[],
): readonly Finding[] {
  const declared = new Set(states);
  const findings: Finding[] = [];
  for (const island of islands) {
    const path = statesPathFor(island);
    if (declared.has(path)) continue;
    findings.push({
      code: CODE,
      cause: `${island} declares no states — x shot --island photographs an island in every state its states file names, so nothing has ever seen this component with a refused save, an empty read or a translated label three times as long as the one it was written against`,
      fix: `write ${path} — defineIslandStates({ island: '${island}', states: [{ id: 'idle', title: 'the first paint', props: {} }] }) — then: x shot --island ${islandName(island)} --json`,
      at: island,
    });
  }
  return findings;
}

export const guard: Guard = {
  summary: 'an island declares the states it can be photographed in',
  async check(root) {
    const islands: string[] = [];
    const states: string[] = [];
    // Two patterns, one per root. These two CAN fold — `{apps,packages}/**/*.island.*` matches the
    // same 12 files on Bun 1.4.0, because a LEADING brace group is fine. What does not work is a
    // brace ALTERNATIVE containing a `/`: `{apps/web,packages/ui}/**/*.tsx` matches ZERO files in
    // `examples/dummy` where `apps/*/{site,app}/**/*.tsx` matches 17, which is why the guards
    // scanning `site`/`app` keep the loop — and this one keeps its shape to match them.
    for (const pattern of ['apps/**/*.island.*', 'packages/**/*.island.*']) {
      for await (const entry of new Bun.Glob(pattern).scan({ cwd: root, absolute: false })) {
        const path = entry.split('\\').join('/');
        if (path.includes('node_modules/') || path.includes('/dist/')) continue;
        if (path.endsWith(ISLAND_SUFFIX)) islands.push(path);
        else if (path.endsWith(STATES_SUFFIX)) states.push(path);
      }
    }
    return islandsWithoutStates(islands.sort(), states);
  },
};
