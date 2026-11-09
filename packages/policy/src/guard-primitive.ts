// The one policy guard `action` and `query` both run: which policy surface each projection is
// judged on, the actor-only stage before the input parse, the full stage after it, and the denial
// read back as one code and one reason. Tier 3 siblings cannot share a file, so it lives here.

import type { Ctx } from '@ultimat3/core';
import { denialCode, denialReason } from './denial-parts';
import { primitiveSurfaceUnknown } from './errors';
import type { Policy } from './policy';
import { enforceBeforeInput } from './pre-input';
import type { Actor } from './roles';
import { enforce, type Surface, type SurfaceDenial } from './surfaces';

/** The two primitives that carry a policy. A mutator is an action; a route asks `evaluate()`. */
export type GuardedPrimitive = 'action' | 'query';

/** Where each primitive runs. `'server'` is in-process app code; `live` is a read's alone. */
export interface PrimitiveSurfaces {
  readonly action: 'server' | 'http' | 'mcp' | 'job';
  readonly query: 'server' | 'http' | 'mcp' | 'live';
}

export type PrimitiveSurface<K extends GuardedPrimitive = GuardedPrimitive> = PrimitiveSurfaces[K];

/**
 * The surface rules, as data. A direct server call has no request and no response to shape, so it
 * is judged as a job. An MCP call is an agent's on BOTH primitives: a read was judged as `'job'`
 * until v31, so its decision events and its denial shape disagreed with an MCP action's.
 */
export const PRIMITIVE_POLICY_SURFACES = Object.freeze<{
  readonly [K in GuardedPrimitive]: Readonly<Record<PrimitiveSurfaces[K], Surface>>;
}>({
  action: Object.freeze<Record<PrimitiveSurfaces['action'], Surface>>({
    server: 'job',
    http: 'http',
    mcp: 'mcp',
    job: 'job',
  }),
  query: Object.freeze<Record<PrimitiveSurfaces['query'], Surface>>({
    server: 'job',
    http: 'http',
    mcp: 'mcp',
    live: 'live',
  }),
});

interface SubjectBase {
  /** The registered name of the primitive — what the denial and `x policy explain` name. */
  readonly name: string;
  readonly actor: Actor | null;
  readonly ctx?: Ctx | undefined;
}

/** Before the input parse: only who is asking. Undecided passes to the `'input'` stage. */
export interface ActorStageSubject extends SubjectBase {
  readonly stage: 'actor';
}

/** After the parse: the input, and the loaded row a row-level rule decides about. */
export interface InputStageSubject<I = unknown, R = unknown> extends SubjectBase {
  readonly stage: 'input';
  readonly input: I;
  /** Omitted when nothing was loaded; `evaluate()` hands the predicate `null`. */
  readonly row?: R | undefined;
}

export type GuardSubject<I = unknown, R = unknown> = ActorStageSubject | InputStageSubject<I, R>;

/** A refusal, already read: the adopting package throws its own error class from it. */
export interface PrimitiveDenial<K extends GuardedPrimitive = GuardedPrimitive> {
  readonly kind: K;
  readonly name: string;
  readonly surface: PrimitiveSurface<K>;
  readonly code: string;
  readonly reason: string;
  /** The surface-shaped denial — a live socket closes 4403 off it, HTTP renders its problem. */
  readonly denial: SurfaceDenial;
}

/**
 * Decide once and return the refusal, or `undefined` to proceed. Returned rather than thrown: the
 * error class is the primitive's (`ActionDeniedError`, `QueryDeniedError`) and this tier cannot
 * name it. The decision event is `evaluate()`'s, emitted once, on the mapped policy surface.
 */
export function guardPrimitive<K extends GuardedPrimitive, I, R>(
  kind: K,
  policy: Policy<I, R>,
  subject: GuardSubject<I, R>,
  surface: PrimitiveSurface<K>,
): PrimitiveDenial<K> | undefined {
  const target = policySurfaceOf(kind, surface);
  const denial =
    subject.stage === 'actor'
      ? enforceBeforeInput(target, policy, actorArgs(subject))
      : enforce(target, policy, {
          input: subject.input,
          actor: subject.actor,
          ...(subject.row === undefined ? {} : { row: subject.row }),
          ...(subject.ctx === undefined ? {} : { ctx: subject.ctx }),
        });
  if (denial === undefined) return undefined;
  return {
    kind,
    name: subject.name,
    surface,
    code: denialCode(denial),
    reason: denialReason(denial),
    denial,
  };
}

function actorArgs(subject: SubjectBase): { actor: Actor | null; ctx?: Ctx } {
  return subject.ctx === undefined
    ? { actor: subject.actor }
    : { actor: subject.actor, ctx: subject.ctx };
}

/** `Object.hasOwn` at both levels, for the reason `enforce()` gives: an index answers `valueOf`. */
function policySurfaceOf(kind: GuardedPrimitive, surface: string): Surface {
  if (!Object.hasOwn(PRIMITIVE_POLICY_SURFACES, kind))
    throw primitiveSurfaceUnknown(kind, surface, []);
  const table: Readonly<Record<string, Surface>> = PRIMITIVE_POLICY_SURFACES[kind];
  if (!Object.hasOwn(table, surface))
    throw primitiveSurfaceUnknown(kind, surface, Object.keys(table));
  return table[surface] as Surface;
}
