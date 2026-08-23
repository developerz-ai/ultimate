// Serving the harness. It is a `x dev` route and not a second server, for the reason `x shot`
// reuses a running dev server at all: the chunks, the app's stylesheet registry and the island
// bundle all live in the process that built them, and embedded Postgres is single-writer so there
// can only be one of those per checkout.

import type { Route, UltimateRequest } from '@ultimat3/http';
import { html, json } from '@ultimat3/http';
import type { IslandStatesManifest } from '@ultimat3/testing';
import {
  islandShotFile,
  islandShotTargets,
  islandStatesMatching,
  islandStatesNames,
  parseIslandAddress,
} from '@ultimat3/testing';
import { harnessPage, ISLAND_HARNESS_PATH } from './island-harness';
import type { IslandSource } from './island-routes';

/**
 * A getter, never the manifests: `x dev` rebuilds on the watcher tick, and a set captured when the
 * route was mounted would serve a state the author has since edited for the rest of the session.
 * It is async because reading a states file is an `import()`, and one that throws is answered as a
 * refusal rather than taking the dev server down.
 */
export type IslandStatesSource = () => Promise<readonly IslandStatesManifest[]>;

const refused = (cause: string, fix: string): Response =>
  json(
    { ok: false, error: { code: 'X_SHOT_ISLAND_UNPHOTOGRAPHABLE', cause, fix } },
    { status: 404 },
  );

export interface HarnessRouteInput {
  readonly islands: IslandSource;
  readonly states: IslandStatesSource;
}

/**
 * `GET /_x/island?island=…&state=…&theme=…`. The address is parsed by the vocabulary's own
 * `parseIslandAddress`, which is `islandAddress`'s inverse and is TOTAL — a mistyped theme falls
 * back rather than throwing, because a page that renders an error over a typo turns a typo into a
 * screenshot of the framework.
 *
 * An island or a state this process does not know is the one case that IS refused, and it can only
 * mean the two processes disagree: `x shot` computed its picture list from the states files on disk
 * and this server was booted against an older set.
 */
export function islandHarnessRoutes(input: HarnessRouteInput): readonly Route[] {
  return [
    {
      method: 'GET',
      path: ISLAND_HARNESS_PATH,
      meta: { name: 'dev._x.island', auth: 'public', tags: ['dev'] },
      handler: async (request: UltimateRequest): Promise<Response> => {
        const address = parseIslandAddress(request.url.search);
        const all = await input.states();
        const manifest = islandStatesMatching(all, address.island)[0];
        if (manifest === undefined) {
          return refused(
            `this dev server declares no island states for ${address.island === '' ? '(no island named)' : address.island} — it knows ${islandStatesNames(all).join(', ') || 'none'}`,
            'restart x dev, then: x shot --island <name> --json',
          );
        }
        // `wanted`, never a local called `state`: `bun run secret-compare` reads the NAME of a
        // comparison's operands and `state` is on its list — an OAuth handshake state is compared
        // under exactly that name, and this one is a screenshot filename stem.
        const wanted = address.state;
        const declared = manifest.states.find((one) => one.id === wanted);
        const file = islandShotFile(manifest.name, wanted, address.theme);
        const target = islandShotTargets(manifest).find((one) => one.file === file);
        if (declared === undefined || target === undefined) {
          return refused(
            `${manifest.island} declares no state ${wanted === '' ? '(none named)' : wanted} in theme ${address.theme}`,
            `x shot --island ${manifest.name} --state ${manifest.states[0]?.id ?? '<id>'} --json`,
          );
        }
        // The chunk is looked up rather than built here: `x dev` already built every island at
        // boot and rebuilds on the watcher tick, so a second build would be a second answer to
        // "what code does this island run".
        const chunk = input.islands().chunks.find((one) => one.file === manifest.island);
        if (chunk === undefined) {
          return refused(
            `${manifest.island} is declared as an island's states file but this build has no chunk for it`,
            `x g island ${manifest.name} --at ${manifest.island.split('/').slice(0, -1).join('/')}`,
          );
        }
        return html(harnessPage({ target, state: declared, entry: chunk.url }));
      },
    },
  ];
}
