// `ClientType` to TypeScript type text, and the names both emitters give a document's types —
// components and the per-operation request and response. One printer for both clients, so the
// customer's `types.ts` and the vendor's `schemas.ts` cannot describe one document two ways.

import type { ClientOperation, ClientType, CompiledDocument } from './openapi-compile-ir';
import { typeName } from './openapi-compile-schema';

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** A property key as TypeScript accepts it: bare when it can be, quoted otherwise. */
export const propertyKey = (name: string): string =>
  IDENTIFIER.test(name) ? name : JSON.stringify(name);

/** Type text for one value, `ref` naming each component the way its file declares it. */
export function typeText(type: ClientType, ref: (component: string) => string): string {
  switch (type.kind) {
    case 'unknown':
    case 'string':
    case 'boolean':
    case 'null':
      return type.kind;
    case 'number':
      return 'number';
    case 'literal':
      return JSON.stringify(type.value);
    case 'array': {
      const items = typeText(type.items, ref);
      return type.items.kind === 'union' ? `(${items})[]` : `${items}[]`;
    }
    case 'record':
      return `Record<string, ${typeText(type.values, ref)}>`;
    case 'union':
      return type.members.map((member) => typeText(member, ref)).join(' | ');
    case 'ref':
      return ref(type.name);
    case 'object':
      if (type.fields.length === 0) return 'Record<string, never>';
      return `{ ${type.fields
        .map((field) =>
          field.required
            ? `${propertyKey(field.name)}: ${typeText(field.type, ref)}`
            : `${propertyKey(field.name)}?: ${typeText(field.type, ref)} | undefined`,
        )
        .join('; ')} }`;
  }
}

/** What an operation's caller passes and gets back, as type text over the document's names. */
export interface OperationTypes {
  /** The input's type text; `undefined` when the operation takes nothing. */
  readonly request?: { readonly name: string; readonly text?: string | undefined } | undefined;
  /** The answer's type name; `undefined` when a success has no body. */
  readonly response?: { readonly name: string; readonly text?: string | undefined } | undefined;
}

export interface DocumentNames {
  /** Component name → the identifier its type and schema are declared under. */
  readonly component: (name: string) => string;
  readonly operation: ReadonlyMap<string, OperationTypes>;
}

/** The parameters as one object type, or `undefined` when there are none. */
export function parametersType(operation: ClientOperation): ClientType | undefined {
  if (operation.parameters.length === 0) return undefined;
  return {
    kind: 'object',
    fields: operation.parameters.map((p) => ({ name: p.name, type: p.type, required: p.required })),
  };
}

/**
 * Every name the document's types take. An operation's request is the body's own name when it is
 * a component and nothing else rides beside it; otherwise `<Op>Request`, suffixed `Op` until it
 * clashes with no component — a vendor's `CreateInvoiceRequest` component keeps its name.
 */
export function documentNames(document: CompiledDocument): DocumentNames {
  const taken = new Set([...document.types.keys()].map(typeName));
  const fresh = (base: string): string => {
    let name = base;
    while (taken.has(name)) name = `${name}Op`;
    taken.add(name);
    return name;
  };
  const component = (name: string): string => typeName(name);
  const operation = new Map<string, OperationTypes>();
  for (const op of document.operations) {
    const pascal = typeName(op.name);
    const params = parametersType(op);
    const paramsText = params === undefined ? undefined : typeText(params, component);
    const body = op.body;
    let request: OperationTypes['request'];
    if (body === undefined) {
      request =
        paramsText === undefined
          ? undefined
          : { name: fresh(`${pascal}Request`), text: paramsText };
    } else if (body.mode === 'value') {
      const value = `{ body${body.required ? '' : '?'}: ${typeText(body.type, component)}${body.required ? '' : ' | undefined'} }`;
      request = {
        name: fresh(`${pascal}Request`),
        text: paramsText === undefined ? value : `${paramsText} & ${value}`,
      };
    } else if (paramsText === undefined && body.type.kind === 'ref') {
      request = { name: component(body.type.name) };
    } else {
      const bodyText = typeText(body.type, component);
      request = {
        name: fresh(`${pascal}Request`),
        text: paramsText === undefined ? bodyText : `${paramsText} & ${bodyText}`,
      };
    }
    const response =
      op.response === undefined
        ? undefined
        : op.response.kind === 'ref'
          ? { name: component(op.response.name) }
          : { name: fresh(`${pascal}Response`), text: typeText(op.response, component) };
    operation.set(op.name, { request, response });
  }
  return { component, operation };
}
