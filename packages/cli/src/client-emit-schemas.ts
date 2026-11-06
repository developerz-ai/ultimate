// The vendor client's `schemas.ts`: every type the operations reach as a TypeScript type AND a `t`
// schema of the same name, so a vendor's answer is parsed, never cast. Components are declared in
// dependency order; only a reference back into a cycle is `lazy`, which is how recursion survives.

import type { DocumentNames } from './client-emit-types';
import { documentNames, parametersType, propertyKey, typeText } from './client-emit-types';
import type { ClientOperation, ClientType, CompiledDocument } from './openapi-compile-ir';

/** Helpers a document needs only when it has a cycle or a value that is only ever null. */
const LAZY = `/** A schema read through a getter, so a recursive type can name itself. */
const lazy = <T>(get: () => Schema<unknown, T>): Schema<unknown, T> =>
  makeSchema<unknown, T>({ kind: 'unknown' }, (value, path) => {
    const result = get().safeParse(value);
    if ('value' in result) return pass(result.value as T);
    return failWith(result.issues.map((issue) => ({ ...issue, path: [...path, ...(issue.path ?? [])] })));
  });`;
const NULL_ONLY = `/** The one value \`null\`. */
const nullValue: Schema<unknown, null> = makeSchema<unknown, null>({ kind: 'unknown' }, (value, path) =>
  value === null ? pass(null) : fail(path, 'expected null'),
);`;

interface Printer {
  readonly declared: Set<string>;
  readonly names: DocumentNames;
  usesLazy: boolean;
  usesNull: boolean;
}

/** `t` text for one type. A component not yet declared is reached through `lazy`. */
export function schemaText(type: ClientType, printer: Printer): string {
  switch (type.kind) {
    case 'unknown':
      return 't.json()';
    case 'string':
      return 't.string';
    case 'number':
      return type.integer ? 't.number.int()' : 't.number';
    case 'boolean':
      return 't.boolean';
    case 'null':
      printer.usesNull = true;
      return 'nullValue';
    case 'literal':
      return `t.literal(${JSON.stringify(type.value)})`;
    case 'array':
      return `t.array(${schemaText(type.items, printer)})`;
    case 'record':
      return `t.record(${schemaText(type.values, printer)})`;
    case 'object':
      return `t.object({ ${type.fields
        .map((field) => {
          const inner = schemaText(field.type, printer);
          return `${propertyKey(field.name)}: ${field.required ? inner : `t.optional(${inner})`}`;
        })
        .join(', ')} })`;
    case 'ref': {
      const name = printer.names.component(type.name);
      if (printer.declared.has(type.name)) return name;
      printer.usesLazy = true;
      return `lazy(() => ${name})`;
    }
    case 'union': {
      const rest = type.members.filter((member) => member.kind !== 'null');
      const nullable = rest.length < type.members.length;
      const strings = rest.every((m) => m.kind === 'literal' && typeof m.value === 'string');
      const inner =
        rest.length === 0
          ? undefined
          : rest.length === 1
            ? schemaText(rest[0] as ClientType, printer)
            : strings
              ? `t.enumerated(${rest.map((m) => (m.kind === 'literal' ? JSON.stringify(m.value) : '')).join(', ')})`
              : `t.union(${rest.map((member) => schemaText(member, printer)).join(', ')})`;
      if (inner === undefined) return schemaText({ kind: 'null' }, printer);
      return nullable ? `t.nullable(${inner})` : inner;
    }
  }
}

/** Component names in an order where each is declared after what it names, cycles aside. */
function dependencyOrder(types: ReadonlyMap<string, ClientType>): readonly string[] {
  const order: string[] = [];
  const state = new Map<string, 'open' | 'done'>();
  const refs = (type: ClientType): readonly string[] => {
    switch (type.kind) {
      case 'ref':
        return [type.name];
      case 'array':
        return refs(type.items);
      case 'record':
        return refs(type.values);
      case 'union':
        return type.members.flatMap(refs);
      case 'object':
        return type.fields.flatMap((field) => refs(field.type));
      default:
        return [];
    }
  };
  const visit = (name: string): void => {
    if (state.has(name)) return;
    state.set(name, 'open');
    const type = types.get(name);
    for (const next of type === undefined ? [] : refs(type)) visit(next);
    state.set(name, 'done');
    order.push(name);
  };
  for (const name of types.keys()) visit(name);
  return order;
}

const opSchema = (op: ClientOperation, part: 'Params' | 'Body' | 'Response'): string =>
  `${op.name}${part}`;

/** `schemas.ts`, unstamped. */
export function emitSchemas(document: CompiledDocument): string {
  const names = documentNames(document);
  const printer: Printer = { declared: new Set(), names, usesLazy: false, usesNull: false };
  const body: string[] = [];
  for (const name of dependencyOrder(document.types)) {
    const type = document.types.get(name) as ClientType;
    const id = names.component(name);
    body.push(`export type ${id} = ${typeText(type, names.component)};`);
    body.push(`export const ${id}: Schema<unknown, ${id}> = ${schemaText(type, printer)};`);
    printer.declared.add(name);
  }
  for (const op of document.operations) {
    const types = names.operation.get(op.name);
    if (types?.request?.text !== undefined) {
      body.push(`export type ${types.request.name} = ${types.request.text};`);
    }
    const params = parametersType(op);
    if (params !== undefined) {
      body.push(`export const ${opSchema(op, 'Params')} = ${schemaText(params, printer)};`);
    }
    if (op.body !== undefined && op.body.type.kind !== 'ref') {
      body.push(`export const ${opSchema(op, 'Body')} = ${schemaText(op.body.type, printer)};`);
    }
    if (types?.response?.text !== undefined && op.response !== undefined) {
      const id = types.response.name;
      body.push(`export type ${id} = ${types.response.text};`);
      body.push(
        `export const ${opSchema(op, 'Response')}: Schema<unknown, ${id}> = ${schemaText(op.response, printer)};`,
      );
    }
  }
  const builders = [
    ...(printer.usesNull ? ['fail'] : []),
    ...(printer.usesLazy ? ['failWith'] : []),
    ...(printer.usesLazy || printer.usesNull ? ['makeSchema', 'pass'] : []),
    't',
  ].sort();
  return [
    `// The shapes of ${document.title} ${document.version}: each a type and a schema of one name.`,
    "import type { Schema } from '@ultimat3/schema';",
    `import { ${builders.join(', ')} } from '@ultimat3/schema';`,
    '',
    ...(printer.usesLazy ? [LAZY, ''] : []),
    ...(printer.usesNull ? [NULL_ONLY, ''] : []),
    ...body,
    '',
  ].join('\n');
}

/** The schema expression `client.ts` parses one operation's part with, through `S.`. */
export function opSchemaRef(
  op: ClientOperation,
  part: 'Params' | 'Body' | 'Response',
  names: DocumentNames,
): string | undefined {
  if (part === 'Params') return op.parameters.length === 0 ? undefined : `S.${opSchema(op, part)}`;
  const type = part === 'Body' ? op.body?.type : op.response;
  if (type === undefined) return undefined;
  return type.kind === 'ref' ? `S.${names.component(type.name)}` : `S.${opSchema(op, part)}`;
}
