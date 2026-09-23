// The actor a route is rendered AS when the render exists only to be weighed — `x build`'s budget
// measurement, whose document is discarded. The default holds every permission and no app facts;
// a page that reads the app's own facts (`useActor()` over `actorFact`) failed `X_ACTOR_UNRESOLVED`
// under it, so the app declares its own here, from `app.config.ts`, with no import of the CLI.

import type { Actor } from './actor';
import { serviceActor } from './actor';
import { assert } from './assert';

/** The id every trace and log line under a default measurement render carries. */
export const MEASUREMENT_ACTOR_ID = 'x-build-measure';

/** What an app declares: the actor its authed pages render as while they are weighed. */
export type MeasurementActorFactory = () => Actor | Promise<Actor>;

let declared: MeasurementActorFactory | undefined;

/**
 * Declare the measurement actor. Called at module scope in `app.config.ts`, the one file every
 * build imports. The LAST declaration wins, because `x dev` re-imports that file on a save and a
 * refusal there would be a reload that fails over a line nobody changed.
 *
 * Only a render that is WEIGHED AND DISCARDED uses it — never a published `site/` artifact, whose
 * `load` must keep failing the build rather than render this actor's rows into a file for everyone.
 */
export function defineMeasurementActor(factory: MeasurementActorFactory): void {
  declared = factory;
}

/**
 * `kind: 'service'` and `'*'`: weighing bytes needs no data authority, and an app's own
 * `requireMember()` has nothing to resolve for a service actor, which is the honest answer.
 */
const defaultMeasurementActor = (): Actor =>
  serviceActor({ id: MEASUREMENT_ACTOR_ID, permissions: ['*'] });

/** The declared actor, or the framework's default. The build's ONE reader. */
export async function measurementActor(): Promise<Actor> {
  if (declared === undefined) return defaultMeasurementActor();
  const actor: Actor | undefined = await declared();
  assert(
    typeof actor === 'object' && actor !== null && typeof actor.id === 'string',
    'the factory handed to defineMeasurementActor() answered no actor',
    'return one from it in app.config.ts: defineMeasurementActor(() => userActor({ id: "measure", roles: ["member"] }))',
  );
  return actor;
}

/** Back to the default. For a test, and for nothing else. */
export function resetMeasurementActor(): void {
  declared = undefined;
}
