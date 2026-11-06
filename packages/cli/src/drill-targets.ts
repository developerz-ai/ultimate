// What `x drill`'s load sends: the site's parameterless pages, read anonymously, and the write
// lane — every action an anonymous POST can reach, each request a fresh input drawn as `x exercise`
// draws one, the app's `exercise.ts` honoured. The writes are how a job reaches the queue over HTTP.

import { toRoute } from '@ultimat3/action';
import type { DrillTarget, DrillWrites } from '@ultimat3/testing';
import { drillWriteTargets } from '@ultimat3/testing';
import { loadApp } from './app-load';
import { readExerciseOverrides } from './exercise-overrides';
import { plainAppRoutes, routeRows } from './route-table';

export interface DrillLoadPlan {
  readonly targets: readonly DrillTarget[];
  readonly skipped: DrillWrites['skipped'];
}

/** The load for the app at `root`; loading it is what fills the registries read here. */
export async function drillTargets(root: string): Promise<DrillLoadPlan> {
  await loadApp(root);
  // Anonymous pages: a non-2xx is the fault's, never a 401's.
  const reads = routeRows(await plainAppRoutes(root))
    .filter((route) => route.surface === 'site' && !/[[:*]/.test(route.path))
    .map((route): DrillTarget => ({ method: 'GET', path: route.path }));
  const { listActions } = await import('@ultimat3/action');
  const writes = await drillWriteTargets({
    actions: listActions().map((action) => {
      const route = toRoute(action);
      return {
        name: action.name,
        method: route.method,
        path: route.path,
        anonymous: route.meta.auth === 'public',
        input: action.input,
      };
    }),
    overrides: await readExerciseOverrides(root),
  });
  return { targets: [...reads, ...writes.targets], skipped: writes.skipped };
}
