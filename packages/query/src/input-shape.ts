// Single responsibility: what a read's `input:` may be, given that a read is projected to
// `GET /_x/query/<kebab>` and a query string is characters.
//
// `client.ts` encoded a nested member as `JSON.stringify(item)` and skipped a `null`; the server's
// own route decodes with `coerceQuery`, which has no inverse for either — `case 'object'` hands
// the raw value back untouched and there is no `JSON.parse` on that path. So the typed client
// type-checked calls the server then answered `X_INPUT_INVALID` for, which is precisely the
// failure `client.ts`'s header claims to prevent ("a compile error in a Solid component rather
// than a 404 at runtime").
//
// The fix is the DECLARATION, not the encoder. Teaching `coerceQuery` to `JSON.parse` a string
// would make the one HTTP-boundary decoder invent structure for every surface that shares it —
// forms and route params included — against that file's own rule that it "never invents data";
// and a `null` sentinel would be a reserved string colliding with the legitimate value `"null"`.
// Refusing here means the client can never encode something the server rejects, because such an
// input cannot be written.

import { type SchemaNode, tryIntrospect } from '@ultimat3/schema';
import { QueryInputUnencodableError } from './errors';

/** Node kinds whose value is a structure, not characters. `money` is `{ minor, currency }`. */
const STRUCTURAL = new Set(['object', 'record', 'money']);

/**
 * The first key this input could not put on a wire, or `undefined`. One key, not a list: a fix
 * line names one edit, and the next declaration attempt reports the next key.
 */
function unencodable(node: SchemaNode): string | undefined {
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    // Required AND nullable: `searchOf` sends nothing for a `null`, and absence is what the far
    // side then sees — so the value the caller explicitly chose fails validation on arrival.
    // Optional or defaulted, absence is already the schema's own answer and nothing is lost.
    if (child.nullable === true && child.optional !== true && child.hasDefault !== true) {
      return `${key} is nullable and required`;
    }
    const kind = structuralKind(child);
    if (kind !== undefined) return `${key} is a ${kind}`;
  }
  return undefined;
}

/** The structural kind inside a member, through an array or a union. */
function structuralKind(node: SchemaNode): string | undefined {
  if (STRUCTURAL.has(node.kind)) return node.kind;
  if (node.kind === 'array' && node.items !== undefined) return structuralKind(node.items);
  if (node.kind === 'union') {
    for (const member of node.anyOf ?? []) {
      const kind = structuralKind(member);
      if (kind !== undefined) return kind;
    }
  }
  return undefined;
}

/**
 * Refused at `query()`, which is the first import of the authoring file — the same place
 * `@ultimat3/schema` refuses a `discriminatedUnion` it could never route, and for the same reason:
 * the declaration is wrong for every input, so the earliest honest moment is where it is written.
 *
 * A schema this package cannot introspect is left alone rather than guessed at: `tryIntrospect`
 * answering `undefined` means a foreign Standard Schema, and refusing one would make the seam
 * `configureSchemaProvider` exists for unusable.
 */
export function assertEncodableInput(input: unknown): void {
  const node = tryIntrospect(input);
  if (node === undefined) return;
  if (node.kind !== 'object') {
    // `searchOf` answers `''` for anything that is not a plain object, so the server receives no
    // arguments at all — a read declared this way is called with an input nothing ever carries.
    throw new QueryInputUnencodableError(`the input is a ${node.kind}, not an object`);
  }
  const offender = unencodable(node);
  if (offender !== undefined) throw new QueryInputUnencodableError(offender);
}
