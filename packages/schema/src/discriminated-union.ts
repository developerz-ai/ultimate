// Single responsibility: a union that dispatches on one literal key instead of trying every
// member. Its own file because the dispatch table and its two authoring refusals are the whole of
// it, and `validators.ts` is already at the size where one more composite stops being readable.

import {
  type AnySchema,
  type Check,
  checkOf,
  fail,
  isPlainObject,
  makeSchema,
  type Schema,
} from './builder';
import { expected } from './describe-value';
import { DiscriminantInvalidError } from './errors';
import type { SchemaNode } from './node';
import type { InferInput, InferOutput } from './standard';

/**
 * What a tag can be — exactly what `SchemaNode.literal` and `SchemaNode.values` can hold. Spelled
 * out rather than left `unknown` because these reach a `cause:` through `String()`, and a value an
 * app controls reaching a refusal's own text is how three constructors learned to throw instead
 * of refusing (`bun run error-render`).
 */
type SchemaTag = string | number | boolean | null | undefined;

/** The literal(s) a member declares at the discriminant, or `undefined` if it declares none. */
function declaredValues(node: SchemaNode, discriminant: string): readonly SchemaTag[] | undefined {
  const child = node.properties?.[discriminant];
  if (child === undefined) return undefined;
  // `kind` gates rather than `literal !== undefined`: `t.literal(false)` is a legal discriminant
  // and a truthiness test would have called it undeclared.
  if (child.kind === 'literal') return [child.literal];
  // An enum member is a legal discriminant too — one branch owning several codes is a real shape
  // (`status: t.enum(['queued', 'running'])`), and refusing it would force a duplicated branch.
  if (child.kind === 'enum' && child.values !== undefined && child.values.length > 0) {
    return [...child.values];
  }
  return undefined;
}

function refuseUndeclared(discriminant: string, index: number, kind: string): never {
  throw new DiscriminantInvalidError({
    cause: `member #${index} of discriminatedUnion("${discriminant}") — IR kind "${kind}" — declares no literal at "${discriminant}"`,
    fix: `give member #${index} a literal discriminant, t.object({ ${discriminant}: t.literal('…'), … }), or use t.union(...) if the members share no key`,
    meta: { discriminant, index, kind },
  });
}

function refuseDuplicate(discriminant: string, index: number, tag: SchemaTag): never {
  throw new DiscriminantInvalidError({
    cause: `member #${index} of discriminatedUnion("${discriminant}") claims the tag ${String(tag)}, which an earlier member already claims`,
    fix: `give member #${index} its own value at "${discriminant}", or merge the two members into one`,
    meta: { discriminant, index, tag: String(tag) },
  });
}

/** `post | page | 2 | false` — every accepted tag, in declaration order. Developer data only. */
function renderKnown(known: readonly SchemaTag[]): string {
  return known.map((value) => String(value)).join(' | ');
}

/**
 * A union whose branch is chosen by one key, not by trying every member in turn.
 *
 * Two things `t.union(...)` cannot do. The message: a failure reports the branch the discriminant
 * NAMED — `t.union` reports every branch's reasons at once, so a typo in a `post` body arrived as
 * N contradictory complaints and the field that was actually wrong was named in none of them. The
 * IR: `discriminator.propertyName` reaches OpenAPI and the MCP tool schema, so a code generator
 * emits one tagged type instead of an untagged `anyOf`.
 *
 * The node stays `kind: 'union'` with a `discriminant` beside it — see `node.ts` for why a new
 * `SchemaKind` would have degraded silently in every consumer that already handles unions.
 */
export function discriminatedUnionSchema<S extends readonly [AnySchema, ...AnySchema[]]>(
  discriminant: string,
  ...members: S
): Schema<InferInput<S[number]>, InferOutput<S[number]>> {
  type Out = InferOutput<S[number]>;
  const branches = new Map<unknown, Check<Out>>();
  const known: SchemaTag[] = [];

  for (const [index, member] of members.entries()) {
    const values = declaredValues(member.node, discriminant);
    if (values === undefined) refuseUndeclared(discriminant, index, member.node.kind);
    const check = checkOf(member) as Check<Out>;
    for (const value of values) {
      // Letting the first declaration win would leave a member that can never run, which is the
      // same defect as an unreachable case and is invisible until the wrong branch validates.
      if (branches.has(value)) refuseDuplicate(discriminant, index, value);
      branches.set(value, check);
      known.push(value);
    }
  }

  const node: SchemaNode = {
    kind: 'union',
    discriminant,
    anyOf: members.map((member) => member.node),
  };

  return makeSchema<InferInput<S[number]>, Out>(node, (value, path) => {
    if (!isPlainObject(value)) {
      return fail(path, expected(`an object with a "${discriminant}" discriminant`, value));
    }
    const branch = branches.get(value[discriminant]);
    if (branch === undefined) {
      return fail(
        [...path, discriminant],
        expected(`one of ${renderKnown(known)}`, value[discriminant]),
      );
    }
    // The named branch's issues, and only those: the caller already said which shape they meant,
    // so the other branches' complaints are noise that hides the one real field error.
    return branch(value, path);
  });
}
