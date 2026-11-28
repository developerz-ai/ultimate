// Compile-time pins for `decide(rows)` landing additively: `ActionDef` and `ActionHandlerArgs` keep
// their 31.51.0 shapes — a call `def.handle({ input, ctx })` written then still compiles — and the
// `Deciding*` pair `action()` reads first hands a handler `decide` typed by the policy's row. Types
// only, for `type-pins.ts`' reason: `tsc -b` never reads a test file.

import type { Ctx } from '@ultimat3/core';
import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import type { ActionDef, ActionHandlerArgs, StreamActionDef } from './action';
import type { ActionDecision } from './action-decide';
import type {
  ActionDecideArgs,
  DecidingActionDef,
  DecidingStreamActionDef,
} from './action-decide-def';

type Assert<T extends true> = T;

type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type In = StandardSchemaV1<{ readonly ids: readonly string[] }>;
type Out = StandardSchemaV1<{ readonly n: number }>;
type Chunk = StandardSchemaV1<string>;
interface Post {
  readonly id: string;
}

/** 31.51.0's `ActionHandlerArgs`, spelt out: what a caller of `def.handle(…)` passes. */
interface RecordedArgs {
  readonly input: InferOutput<In>;
  readonly ctx: Ctx;
}

export type _HandlerArgsKeep3151Shape = Assert<Identical<ActionHandlerArgs<In>, RecordedArgs>>;
export type _ActionDefHandleTakes3151Args = Assert<
  Identical<Parameters<ActionDef<In, Out, Post>['handle']>[0], ActionHandlerArgs<In>>
>;
export type _StreamDefHandleTakes3151Args = Assert<
  Identical<Parameters<StreamActionDef<In, Out, Chunk, Post>['handle']>[0], ActionHandlerArgs<In>>
>;

/** A declaration an app typed `ActionDef` still goes into `action()`'s first overload. */
export type _ActionDefIsADecidingDef = Assert<
  ActionDef<In, Out, Post> extends DecidingActionDef<In, Out, Post> ? true : false
>;
export type _StreamDefIsADecidingDef = Assert<
  StreamActionDef<In, Out, Chunk, Post> extends DecidingStreamActionDef<In, Out, Chunk, Post>
    ? true
    : false
>;

/** The handler's `decide` takes the policy's rows alone and answers them. */
type Decide = Parameters<DecidingActionDef<In, Out, Post>['handle']>[0]['decide'];
export type _DecideTakesRowsAlone = Assert<Identical<Parameters<Decide>, [rows: readonly Post[]]>>;
export type _DecideAnswersTheRows = Assert<Identical<ReturnType<Decide>, ActionDecision<Post>>>;
export type _DecideArgsAreTheRecordedOnesPlusDecide = Assert<
  Identical<Exclude<keyof ActionDecideArgs<In, Post>, keyof RecordedArgs>, 'decide'>
>;
